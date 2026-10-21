import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { assertDealershipAccess } from "../middleware/authorizeRole";
import type { RequestUser } from "../middleware/authenticate";
import {
  dealershipModel,
  toDealershipDTO,
  type DealershipDTO,
} from "../models/dealership.model";
import { paginate, skipTake, type Paginated, type Pagination } from "../utils/pagination";
import { toUserDTO, type UserDTO } from "../models/user.model";

interface ListQuery extends Pagination {
  status?: "active" | "inactive";
  search?: string;
}

export const dealershipService = {
  /**
   * Accountants only see dealerships they are assigned to; admins see all.
   */
  async list(q: ListQuery, user: RequestUser): Promise<Paginated<DealershipDTO>> {
    const where: Prisma.DealershipWhereInput = {
      ...(q.status ? { isActive: q.status === "active" } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: "insensitive" } },
              { code: { contains: q.search, mode: "insensitive" } },
              { city: { contains: q.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(user.role === "ACCOUNTANT" ? { id: { in: user.dealershipIds } } : {}),
    };
    const [rows, total] = await dealershipModel.list({ where, ...skipTake(q) });
    return paginate(rows.map(toDealershipDTO), total, q);
  },

  async getById(id: string, user: RequestUser): Promise<DealershipDTO> {
    assertDealershipAccess(user, id);
    const d = await dealershipModel.findById(id);
    if (!d) throw ApiError.notFound("Dealership not found.");
    return toDealershipDTO(d);
  },

  async create(input: Prisma.DealershipCreateInput): Promise<DealershipDTO> {
    try {
      return toDealershipDTO(await dealershipModel.create(input));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("A dealership with this code already exists.");
      }
      throw e;
    }
  },

  async update(id: string, patch: Prisma.DealershipUpdateInput): Promise<DealershipDTO> {
    const existing = await dealershipModel.findById(id);
    if (!existing) throw ApiError.notFound("Dealership not found.");
    try {
      return toDealershipDTO(await dealershipModel.update(id, patch));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("A dealership with this code already exists.");
      }
      throw e;
    }
  },

  /**
   * Deactivation only — dealerships with financial history are never deleted.
   */
  async setStatus(id: string, isActive: boolean): Promise<DealershipDTO> {
    const existing = await dealershipModel.findById(id);
    if (!existing) throw ApiError.notFound("Dealership not found.");
    return toDealershipDTO(await dealershipModel.update(id, { isActive }));
  },

  /**
   * Permanent delete — only allowed while the dealership has no financial
   * footprint (bills, schedules, budgets). Rows with history must be
   * deactivated instead so the audit trail stays intact.
   */
  async remove(id: string): Promise<void> {
    const existing = await dealershipModel.findById(id);
    if (!existing) throw ApiError.notFound("Dealership not found.");
    const [bills, schedules, budgets] = await Promise.all([
      prisma.bill.count({ where: { dealershipId: id } }),
      prisma.billSchedule.count({ where: { dealershipId: id } }),
      prisma.budgetRule.count({ where: { dealershipId: id } }),
    ]);
    if (bills || schedules || budgets) {
      throw ApiError.conflict(
        `Cannot permanently delete: dealership has ${bills} bill(s), ${schedules} schedule(s) and ${budgets} budget(s). Deactivate it instead.`
      );
    }
    await prisma.dealership.delete({ where: { id } });
  },

  /** Admin-only: accountants assigned to a dealership. */
  async accountantsFor(dealershipId: string): Promise<UserDTO[]> {
    const d = await dealershipModel.findById(dealershipId);
    if (!d) throw ApiError.notFound("Dealership not found.");
    const rows = await dealershipModel.accountantsFor(dealershipId);
    return rows.map((u) => toUserDTO(u as never));
  },
};
