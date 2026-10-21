import type { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import {
  notificationModel,
  toNotificationDTO,
  type NotificationDTO,
} from "../models/notification.model";
import { paginate, type Paginated, type Pagination } from "../utils/pagination";

export interface NotifyInput {
  recipientId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  deduplicationKey?: string;
}

export const notificationService = {
  /** Persistent in-app notifications; dedup keys make job runs idempotent. */
  async notify(rows: NotifyInput[], tx?: Prisma.TransactionClient): Promise<void> {
    if (rows.length === 0) return;
    const client = tx ?? prisma;
    await client.notification.createMany({
      data: rows.map((r) => ({
        recipientId: r.recipientId,
        type: r.type,
        title: r.title,
        message: r.message,
        relatedEntityType: r.relatedEntityType,
        relatedEntityId: r.relatedEntityId,
        deduplicationKey: r.deduplicationKey,
      })),
      skipDuplicates: true,
    });
  },

  async notifyAdmins(
    rows: Omit<NotifyInput, "recipientId">[],
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
    });
    await this.notify(
      admins.flatMap((a) => rows.map((r) => ({ ...r, recipientId: a.id }))),
      tx
    );
  },

  async list(
    userId: string,
    q: Pagination & { unreadOnly?: boolean }
  ): Promise<Paginated<NotificationDTO>> {
    const [rows, total] = await notificationModel.listFor(userId, {
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      unreadOnly: q.unreadOnly,
    });
    return paginate(rows.map(toNotificationDTO), total, q);
  },

  async unreadCount(userId: string): Promise<number> {
    return notificationModel.unreadCount(userId);
  },

  /** Ownership is enforced by scoping every query to recipientId. */
  async markRead(id: string, userId: string): Promise<void> {
    const result = await notificationModel.markRead(id, userId);
    if (result.count === 0) {
      const exists = await notificationModel.findOwned(id, userId);
      if (!exists) throw ApiError.notFound("Notification not found.");
    }
  },

  async markAllRead(userId: string): Promise<void> {
    await notificationModel.markAllRead(userId);
  },
};
