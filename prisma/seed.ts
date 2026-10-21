import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

/**
 * Database seed.
 *
 * Always seeds the eight bill categories (idempotent). When
 * SEED_DEMO_DATA=true it also creates demo dealerships, demo users matching
 * the frontend's documented demo accounts, budgets, and a few schedules.
 *
 *   npm run db:seed
 */
const prisma = new PrismaClient();

const CATEGORIES = [
  ["Electricity", "receipt"],
  ["Water", "droplet"],
  ["Internet", "wifi"],
  ["Telephone", "phone"],
  ["Maintenance", "wrench"],
  ["Cleaning", "sparkles"],
  ["Security", "shield"],
  ["Other", "file"],
] as const;

const DEMO_DEALERSHIPS = [
  { name: "Riverside Motors", code: "RVM", city: "Pune", state: "Maharashtra", address: "12 River Road" },
  { name: "Hillcrest Auto", code: "HCA", city: "Bengaluru", state: "Karnataka", address: "48 Hill Avenue" },
  { name: "Northgate Vehicles", code: "NGV", city: "Delhi", state: "Delhi", address: "7 North Gate" },
] as const;

const DEMO_USERS = [
  { name: "Admin User", email: "admin@autoledger.com", password: "admin123", role: "ADMIN" as const, title: "Finance Admin" },
  { name: "Asha Verma", email: "accountant@autoledger.com", password: "account123", role: "ACCOUNTANT" as const, title: "Senior Accountant", dealerships: ["RVM", "HCA"] },
  { name: "Lena D'Souza", email: "lena@autoledger.com", password: "account123", role: "ACCOUNTANT" as const, title: "Accountant", dealerships: ["NGV"] },
] as const;

async function main() {
  console.log("Seeding categories…");
  for (const [name, icon] of CATEGORIES) {
    await prisma.billCategory.upsert({
      where: { name },
      update: {},
      create: { name, icon, description: `${name} utility bills` },
    });
  }

  if (process.env.SEED_DEMO_DATA !== "true") {
    console.log("SEED_DEMO_DATA is not true — categories only. Done.");
    return;
  }

  console.log("Seeding demo dealerships…");
  const dealerships = new Map<string, string>();
  for (const d of DEMO_DEALERSHIPS) {
    const row = await prisma.dealership.upsert({
      where: { code: d.code },
      update: {},
      create: d,
    });
    dealerships.set(d.code, row.id);
  }

  console.log("Seeding demo users…");
  for (const u of DEMO_USERS) {
    const passwordHash = await bcrypt.hash(u.password, 12);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        fullName: u.name,
        email: u.email,
        passwordHash,
        role: u.role,
        title: u.title,
      },
    });
    if ("dealerships" in u && u.dealerships) {
      for (const code of u.dealerships) {
        await prisma.dealershipAssignment.upsert({
          where: { userId_dealershipId: { userId: user.id, dealershipId: dealerships.get(code)! } },
          update: {},
          create: { userId: user.id, dealershipId: dealerships.get(code)! },
        });
      }
    }
  }

  console.log("Seeding demo budgets + schedules…");
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@autoledger.com" } });
  const cats = await prisma.billCategory.findMany();
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const electricity = cats.find((c) => c.name === "Electricity")!;
  const water = cats.find((c) => c.name === "Water")!;

  for (const [code, dealershipId] of dealerships) {
    for (const cat of [electricity, water]) {
      await prisma.budgetRule.upsert({
        where: {
          dealershipId_categoryId_effectiveMonth: {
            dealershipId,
            categoryId: cat.id,
            effectiveMonth: thisMonth,
          },
        },
        update: {},
        create: {
          dealershipId,
          categoryId: cat.id,
          effectiveMonth: thisMonth,
          monthlyAmount: code === "RVM" ? 45000 : 30000,
          createdById: admin.id,
        },
      });
    }

    const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(28, now.getUTCDate() + 5)));
    const deadline = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(28, now.getUTCDate() + 10)));
    try {
      await prisma.billSchedule.create({
        data: {
          dealershipId,
          categoryId: electricity.id,
          billingPeriod: thisMonth,
          dueDate: due,
          submissionDeadline: deadline,
          createdById: admin.id,
          instructions: "Upload the electricity bill PDF from the provider portal.",
        },
      });
    } catch {
      /* duplicate schedule — seed is idempotent */
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
