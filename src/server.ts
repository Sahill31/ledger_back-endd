import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/database";
import { createApp } from "./app";
import { startInProcessJobs, stopInProcessJobs } from "./jobs/overdueSchedules.job";

async function main() {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, prefix: env.API_PREFIX, storage: env.STORAGE_PROVIDER },
      "autoledger-api listening"
    );
  });

  startInProcessJobs();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopInProcessJobs();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    // Force-exit if connections don't drain promptly.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
