import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Must run before ANY src import in every test worker — otherwise the app
    // Prisma client binds the dev DATABASE_URL loaded from .env.
    setupFiles: ["tests/helpers/env.ts"],
    // Integration tests share one Postgres test database — run serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
