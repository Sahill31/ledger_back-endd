import type { BillCategory } from "@prisma/client";
import { prisma } from "../config/database";

export interface CategoryDTO {
  id: string;
  name: string;
  description?: string;
  icon: string;
  active: boolean;
  createdAt: string;
}

export function toCategoryDTO(c: BillCategory): CategoryDTO {
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? undefined,
    icon: c.icon,
    active: c.isActive,
    createdAt: c.createdAt.toISOString(),
  };
}

export const categoryModel = {
  list(includeInactive = true) {
    return prisma.billCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: "asc" },
    });
  },
  findById(id: string) {
    return prisma.billCategory.findUnique({ where: { id } });
  },
  create(data: { name: string; description?: string; icon?: string }) {
    return prisma.billCategory.create({ data });
  },
  update(id: string, data: { name?: string; description?: string | null; icon?: string; isActive?: boolean }) {
    return prisma.billCategory.update({ where: { id }, data });
  },
};
