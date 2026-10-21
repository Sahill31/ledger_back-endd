import { Prisma, type Dealership } from "@prisma/client";
import { prisma } from "../config/database";

export interface DealershipDTO {
  id: string;
  name: string;
  code: string;
  address: string;
  city: string;
  state?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status: "active" | "inactive";
  createdAt: string;
}

export function toDealershipDTO(d: Dealership): DealershipDTO {
  return {
    id: d.id,
    name: d.name,
    code: d.code,
    address: d.address,
    city: d.city,
    state: d.state ?? undefined,
    contactName: d.contactName ?? undefined,
    phone: d.contactPhone ?? undefined,
    email: d.contactEmail ?? undefined,
    status: d.isActive ? "active" : "inactive",
    createdAt: d.createdAt.toISOString(),
  };
}

export const dealershipModel = {
  findById(id: string) {
    return prisma.dealership.findUnique({ where: { id } });
  },
  list(args: { where: Prisma.DealershipWhereInput; skip: number; take: number }) {
    const { where, skip, take } = args;
    return Promise.all([
      prisma.dealership.findMany({ where, orderBy: { name: "asc" }, skip, take }),
      prisma.dealership.count({ where }),
    ]);
  },
  create(data: Prisma.DealershipCreateInput) {
    return prisma.dealership.create({ data });
  },
  update(id: string, data: Prisma.DealershipUpdateInput) {
    return prisma.dealership.update({ where: { id }, data });
  },
  /** Accountants for a dealership (admin tooling). */
  accountantsFor(dealershipId: string) {
    return prisma.user.findMany({
      where: {
        role: "ACCOUNTANT",
        assignments: { some: { dealershipId } },
      },
      select: {
        id: true, fullName: true, email: true, isActive: true,
        assignments: { select: { dealershipId: true } },
      },
      orderBy: { fullName: "asc" },
    });
  },
};
