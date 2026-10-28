import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { storage } from "../config/storage";
import { logger } from "../config/logger";
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
   * Permanent delete — removes the dealership AND every dependent record it
   * owns in one transaction: bills (+ review history via cascade), schedules,
   * budget rules (+ history), scans, accountant assignments. Uploaded bill
   * documents are then deleted from storage on a best-effort basis.
   *
   * This is destructive by admin request; deactivation is the safe default.
   */
  async remove(id: string): Promise<void> {
    const existing = await dealershipModel.findById(id);
    if (!existing) throw ApiError.notFound("Dealership not found.");

    const billRows = await prisma.bill.findMany({
      where: { dealershipId: id },
      select: { id: true, documentKey: true },
    });
    const scanRows = await prisma.documentScan.findMany({
      where: { dealershipId: id },
      select: { documentKey: true },
    });
    const scheduleIds = (
      await prisma.billSchedule.findMany({
        where: { dealershipId: id },
        select: { id: true },
      })
    ).map((s) => s.id);

    // Notifications point at entities via a loose relatedEntityId string —
    // remove the ones referencing anything about to disappear.
    const relatedIds = [id, ...billRows.map((b) => b.id), ...scheduleIds];

    await prisma.$transaction(async (tx) => {
      // Order matters — bills/schedules/budgets FK to the dealership with
      // RESTRICT, so dependents go first.
      await tx.notification.deleteMany({ where: { relatedEntityId: { in: relatedIds } } });
      await tx.bill.deleteMany({ where: { dealershipId: id } });
      await tx.billSchedule.deleteMany({ where: { dealershipId: id } });
      await tx.budgetRule.deleteMany({ where: { dealershipId: id } });
      await tx.documentScan.deleteMany({ where: { dealershipId: id } });
      await tx.dealership.delete({ where: { id } });
    });

    // Best-effort storage cleanup — never fail the request over files.
    const docKeys = [...billRows.map((b) => b.documentKey), ...scanRows.map((s) => s.documentKey)];
    for (const documentKey of docKeys) {
      try {
        await storage.delete(documentKey);
      } catch (err) {
        logger.warn({ err, documentKey }, "orphaned storage object after dealership delete");
      }
    }
  },

  /** Admin-only: accountants assigned to a dealership. */
  async accountantsFor(dealershipId: string): Promise<UserDTO[]> {
    const d = await dealershipModel.findById(dealershipId);
    if (!d) throw ApiError.notFound("Dealership not found.");
    const rows = await dealershipModel.accountantsFor(dealershipId);
    return rows.map((u) => toUserDTO(u as never));
  },
};
