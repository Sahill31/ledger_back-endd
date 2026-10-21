import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { paginate, skipTake, type Paginated, type Pagination } from "../utils/pagination";
import {
  normalizeEmail,
  toUserDTO,
  userModel,
  type UserDTO,
} from "../models/user.model";
import type { RequestUser } from "../middleware/authenticate";
import { authService } from "./auth.service";

interface ListQuery extends Pagination {
  role?: "ADMIN" | "ACCOUNTANT";
  status?: "active" | "inactive";
  search?: string;
}

export const userService = {
  async list(q: ListQuery): Promise<Paginated<UserDTO>> {
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { isActive: q.status === "active" } : {}),
      ...(q.search
        ? {
            OR: [
              { fullName: { contains: q.search, mode: "insensitive" } },
              { email: { contains: q.search.toLowerCase(), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [rows, total] = await userModel.list({ where, ...skipTake(q) });
    return paginate(rows.map(toUserDTO), total, q);
  },

  async getById(id: string): Promise<UserDTO> {
    const user = await userModel.findById(id);
    if (!user) throw ApiError.notFound("Account not found.");
    return toUserDTO(user);
  },

  /**
   * Admin-only provisioning. `role` comes only from this guarded endpoint —
   * there is no public registration path.
   */
  async create(
    input: {
      fullName: string;
      email: string;
      password: string;
      role: "ADMIN" | "ACCOUNTANT";
      title?: string;
      phone?: string;
      dealershipIds: string[];
    },
    actor: RequestUser
  ): Promise<UserDTO> {
    const email = normalizeEmail(input.email);
    const existing = await userModel.findByEmail(email);
    if (existing) throw ApiError.conflict("An account with this email already exists.");

    // Assignments are only meaningful for accountants.
    const dealershipIds = input.role === "ACCOUNTANT" ? input.dealershipIds : [];
    if (dealershipIds.length) {
      const found = await prisma.dealership.count({ where: { id: { in: dealershipIds } } });
      if (found !== dealershipIds.length) {
        throw ApiError.unprocessable("One or more dealerships do not exist.");
      }
    }

    const passwordHash = await authService.hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        fullName: input.fullName.trim(),
        email,
        passwordHash,
        role: input.role === "ADMIN" ? UserRole.ADMIN : UserRole.ACCOUNTANT,
        title: input.title,
        phone: input.phone,
        assignments: { create: dealershipIds.map((dealershipId) => ({ dealershipId })) },
      },
      include: { assignments: { select: { dealershipId: true } } },
    });
    void actor;
    return toUserDTO(user);
  },

  /** Profile fields only — role/isActive cannot change here (see schema). */
  async update(
    id: string,
    patch: {
      fullName?: string;
      email?: string;
      title?: string | null;
      phone?: string | null;
      password?: string;
    }
  ): Promise<UserDTO> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Account not found.");
    const data: Prisma.UserUpdateInput = {
      ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
      ...(patch.email !== undefined ? { email: normalizeEmail(patch.email) } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    };
    if (patch.password) {
      data.passwordHash = await authService.hashPassword(patch.password);
    }
    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id },
          data,
          include: { assignments: { select: { dealershipId: true } } },
        });
        if (patch.password) {
          await tx.refreshToken.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return u;
      });
      return toUserDTO(user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("An account with this email already exists.");
      }
      throw e;
    }
  },

  /**
   * Status change is admin-only AND self-lockout is blocked — a user may not
   * modify their own active status.
   */
  async setStatus(id: string, isActive: boolean, actor: RequestUser): Promise<UserDTO> {
    if (id === actor.id) {
      throw ApiError.forbidden("You cannot change your own account status.");
    }
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Account not found.");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { isActive },
        include: { assignments: { select: { dealershipId: true } } },
      });
      if (!isActive) {
        // Kill live sessions immediately for deactivated accounts.
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return u;
    });
    return toUserDTO(user);
  },

  /**
   * Permanent delete — guards: no self-delete, never the last active admin,
   * and accounts with a financial footprint (submitted bills, reviews,
   * created schedules/budgets) cannot be removed; deactivate them instead.
   */
  async remove(id: string, actor: RequestUser): Promise<void> {
    if (id === actor.id) {
      throw ApiError.forbidden("You cannot delete your own account.");
    }
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Account not found.");
    if (existing.role === UserRole.ADMIN) {
      const admins = await prisma.user.count({
        where: { role: UserRole.ADMIN, isActive: true },
      });
      if (admins <= 1) {
        throw ApiError.conflict("Cannot delete the last active administrator.");
      }
    }
    const [bills, reviews, schedules, budgets] = await Promise.all([
      prisma.bill.count({ where: { submittedById: id } }),
      prisma.billReviewHistory.count({ where: { reviewerId: id } }),
      prisma.billSchedule.count({ where: { createdById: id } }),
      prisma.budgetRule.count({ where: { createdById: id } }),
    ]);
    const footprint = bills + reviews + schedules + budgets;
    if (footprint > 0) {
      throw ApiError.conflict(
        "Cannot permanently delete: account has submitted bills, reviews or created records. Deactivate it instead."
      );
    }
    await prisma.user.delete({ where: { id } });
  },

  async getAssignments(id: string): Promise<string[]> {
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw ApiError.notFound("Account not found.");
    const rows = await prisma.dealershipAssignment.findMany({
      where: { userId: id },
      select: { dealershipId: true },
    });
    return rows.map((r) => r.dealershipId);
  },

  /** Replace assignment set atomically. Only valid for accountants. */
  async setAssignments(id: string, dealershipIds: string[]): Promise<UserDTO> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Account not found.");
    if (existing.role !== UserRole.ACCOUNTANT) {
      throw ApiError.unprocessable("Dealership assignments apply to accountant accounts only.");
    }
    if (dealershipIds.length) {
      const found = await prisma.dealership.count({ where: { id: { in: dealershipIds } } });
      if (found !== new Set(dealershipIds).size) {
        throw ApiError.unprocessable("One or more dealerships do not exist.");
      }
    }
    const user = await prisma.$transaction(async (tx) => {
      await tx.dealershipAssignment.deleteMany({ where: { userId: id } });
      if (dealershipIds.length) {
        await tx.dealershipAssignment.createMany({
          data: [...new Set(dealershipIds)].map((dealershipId) => ({ userId: id, dealershipId })),
          skipDuplicates: true,
        });
      }
      return tx.user.findUniqueOrThrow({
        where: { id },
        include: { assignments: { select: { dealershipId: true } } },
      });
    });
    return toUserDTO(user);
  },
};
