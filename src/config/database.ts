import { PrismaClient } from "@prisma/client";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Reusable Prisma client. Prisma manages a bounded pg connection pool
 * internally (default pool size = num_cpus * 2 + 1); override via the
 * `connection_limit` query param on DATABASE_URL for the deployment.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace"
        ? [
            { emit: "event", level: "query" },
            { emit: "event", level: "warn" },
            { emit: "event", level: "error" },
          ]
        : [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }],
  });

if (!env.isProd) {
  // Avoid creating a new client on every tsx watch reload.
  globalForPrisma.prisma = prisma;
}

prisma.$on("error" as never, (e: unknown) => logger.error(e, "prisma error"));
prisma.$on("warn" as never, (e: unknown) => logger.warn(e, "prisma warning"));

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, "database connectivity check failed");
    return false;
  }
}
