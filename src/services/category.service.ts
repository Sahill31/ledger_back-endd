import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { categoryModel, toCategoryDTO, type CategoryDTO } from "../models/category.model";

export const categoryService = {
  async list(): Promise<CategoryDTO[]> {
    // All authenticated users see all categories (incl. inactive for history).
    return (await categoryModel.list()).map(toCategoryDTO);
  },

  async create(input: { name: string; description?: string; icon?: string }): Promise<CategoryDTO> {
    try {
      return toCategoryDTO(
        await categoryModel.create({ ...input, name: input.name.trim() })
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("A category with this name already exists.");
      }
      throw e;
    }
  },

  async update(
    id: string,
    patch: { name?: string; description?: string | null; icon?: string }
  ): Promise<CategoryDTO> {
    const existing = await categoryModel.findById(id);
    if (!existing) throw ApiError.notFound("Category not found.");
    try {
      return toCategoryDTO(
        await categoryModel.update(id, {
          ...patch,
          name: patch.name?.trim(),
        })
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("A category with this name already exists.");
      }
      throw e;
    }
  },

  /** Deactivate — historical bills keep their category reference. */
  async setStatus(id: string, isActive: boolean): Promise<CategoryDTO> {
    const existing = await categoryModel.findById(id);
    if (!existing) throw ApiError.notFound("Category not found.");
    return toCategoryDTO(await categoryModel.update(id, { isActive }));
  },

  /**
   * Permanent delete — only allowed while nothing references the category
   * (bills, schedules, budgets). Referenced categories must be deactivated
   * so historical records keep their reference.
   */
  async remove(id: string): Promise<void> {
    const existing = await categoryModel.findById(id);
    if (!existing) throw ApiError.notFound("Category not found.");
    const [bills, schedules, budgets] = await Promise.all([
      prisma.bill.count({ where: { categoryId: id } }),
      prisma.billSchedule.count({ where: { categoryId: id } }),
      prisma.budgetRule.count({ where: { categoryId: id } }),
    ]);
    if (bills || schedules || budgets) {
      throw ApiError.conflict(
        `Cannot permanently delete: category is used by ${bills} bill(s), ${schedules} schedule(s) and ${budgets} budget(s). Deactivate it instead.`
      );
    }
    await prisma.billCategory.delete({ where: { id } });
  },
};
