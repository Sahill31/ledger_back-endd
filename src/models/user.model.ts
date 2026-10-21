import { Prisma, UserRole, type User } from "@prisma/client";
import { prisma } from "../config/database";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: "admin" | "accountant";
  title?: string;
  phone?: string;
  status: "active" | "inactive";
  dealershipIds: string[];
  createdAt: string;
  lastLoginAt?: string;
}

type UserWithAssignments = User & {
  assignments: { dealershipId: string }[];
};

/** Response DTO — never leaks passwordHash. */
export function toUserDTO(u: UserWithAssignments): UserDTO {
  return {
    id: u.id,
    name: u.fullName,
    email: u.email,
    role: u.role === "ADMIN" ? "admin" : "accountant",
    title: u.title ?? undefined,
    phone: u.phone ?? undefined,
    status: u.isActive ? "active" : "inactive",
    dealershipIds: u.assignments.map((a) => a.dealershipId),
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString(),
  };
}

export const userInclude = { assignments: { select: { dealershipId: true } } } as const;

export const userModel = {
  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  },
  findById(id: string) {
    return prisma.user.findUnique({ where: { id }, include: userInclude });
  },
  list(args: {
    where: Prisma.UserWhereInput;
    skip: number;
    take: number;
  }) {
    const { where, skip, take } = args;
    return Promise.all([
      prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ]);
  },
  create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data, include: userInclude });
  },
  update(id: string, data: Prisma.UserUpdateInput) {
    return prisma.user.update({ where: { id }, data, include: userInclude });
  },
  isAssignedToDealership(userId: string, dealershipId: string) {
    return prisma.dealershipAssignment.findUnique({
      where: { userId_dealershipId: { userId, dealershipId } },
    });
  },
  activeAdmins() {
    return prisma.user.findMany({
      where: { role: UserRole.ADMIN, isActive: true },
      select: { id: true, fullName: true },
    });
  },
};
