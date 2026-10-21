import "./env"; // must precede any src/ import
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, UserRole } from "@prisma/client";
import { signAccessToken } from "../../src/middleware/authenticate";
import { firstOfMonth } from "../../src/utils/date";

export const prisma = new PrismaClient();

let counter = 0;
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${counter++}`;

/** Truncate all business tables between tests (FK-safe via CASCADE). */
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      notifications, bill_review_history, bills, document_scans, bill_schedules,
      budget_rule_history, budget_rules, dealership_assignments,
      dealerships, bill_categories, refresh_tokens, password_reset_tokens, users
    CASCADE
  `);
}

export async function makeUser(opts: {
  role: UserRole;
  isActive?: boolean;
  dealershipIds?: string[];
  password?: string;
}) {
  const user = await prisma.user.create({
    data: {
      fullName: `${opts.role === "ADMIN" ? "Admin" : "Acct"} ${uniq("u")}`,
      email: `${uniq("user")}@test.local`,
      passwordHash: await bcrypt.hash(opts.password ?? "passw0rd1", 10),
      role: opts.role,
      isActive: opts.isActive ?? true,
    },
  });
  for (const dealershipId of opts.dealershipIds ?? []) {
    await prisma.dealershipAssignment.create({ data: { userId: user.id, dealershipId } });
  }
  const token = signAccessToken(user);
  return { user, token };
}

export async function makeDealership() {
  return prisma.dealership.create({
    data: {
      name: `Dealer ${uniq("d")}`,
      code: uniq("D").toUpperCase().slice(0, 20),
      address: "1 Test St",
      city: "Testville",
    },
  });
}

export async function makeCategory(name = "Electricity") {
  return prisma.billCategory.create({ data: { name: `${name} ${uniq("c")}` } });
}

export async function makeSchedule(opts: {
  dealershipId: string;
  categoryId: string;
  createdById: string;
  assignedAccountantId?: string;
  submissionDeadline?: Date;
  billingPeriod?: Date;
}) {
  return prisma.billSchedule.create({
    data: {
      dealershipId: opts.dealershipId,
      categoryId: opts.categoryId,
      createdById: opts.createdById,
      assignedAccountantId: opts.assignedAccountantId ?? null,
      billingPeriod: opts.billingPeriod ?? firstOfMonth(2026, 10),
      dueDate: new Date(Date.UTC(2026, 9, 20)),
      submissionDeadline: opts.submissionDeadline ?? new Date(Date.UTC(2026, 9, 25)),
    },
  });
}

export const pdfBuffer = () => Buffer.from("%PDF-1.4 test file", "latin1");

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const billPayload = (opts: {
  dealershipId: string;
  categoryId: string;
  scheduleId?: string;
  amount?: number;
}) => ({
  dealershipId: opts.dealershipId,
  categoryId: opts.categoryId,
  scheduleId: opts.scheduleId,
  billingPeriod: { month: 10, year: 2026 },
  billingDate: "2026-10-12",
  amount: opts.amount ?? 100.5,
  referenceNumber: randomUUID().slice(0, 8),
});
