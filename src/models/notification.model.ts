import type { Notification, NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../config/database";

export interface NotificationDTO {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  read: boolean;
  readAt?: string;
  createdAt: string;
}

export function toNotificationDTO(n: Notification): NotificationDTO {
  return {
    id: n.id,
    userId: n.recipientId,
    type: n.type,
    title: n.title,
    message: n.message,
    relatedEntityType: n.relatedEntityType ?? undefined,
    relatedEntityId: n.relatedEntityId ?? undefined,
    read: n.readAt !== null,
    readAt: n.readAt?.toISOString(),
    createdAt: n.createdAt.toISOString(),
  };
}

export const notificationModel = {
  listFor(userId: string, args: { skip: number; take: number; unreadOnly?: boolean }) {
    const where: Prisma.NotificationWhereInput = {
      recipientId: userId,
      ...(args.unreadOnly ? { readAt: null } : {}),
    };
    return Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: args.skip,
        take: args.take,
      }),
      prisma.notification.count({ where }),
    ]);
  },
  unreadCount(userId: string) {
    return prisma.notification.count({ where: { recipientId: userId, readAt: null } });
  },
  findOwned(id: string, userId: string) {
    return prisma.notification.findFirst({ where: { id, recipientId: userId } });
  },
  markRead(id: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  },
  markAllRead(userId: string) {
    return prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  },
  /**
   * Bulk insert honoring the deduplication_key partial unique index —
   * repeated job runs never create duplicates.
   */
  createManySkipDuplicates(rows: Prisma.NotificationCreateManyInput[]) {
    if (rows.length === 0) return Promise.resolve({ count: 0 });
    return prisma.notification.createMany({ data: rows, skipDuplicates: true });
  },
};
