/**
 * Test environment — MUST be imported before any src/ module so dotenv+env
 * validation pick up these values (dotenv never overrides existing vars).
 */
import os from "node:os";
import path from "node:path";

const testDefaults: Record<string, string> = {
  NODE_ENV: "test",
  PORT: "5999",
  API_PREFIX: "/api/v1",
  FRONTEND_URL: "http://localhost:5173",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres:password@localhost:5432/autoledger_test",
  JWT_ACCESS_SECRET: "test-access-secret-0123456789abcdef",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_SECRET: "test-refresh-secret-0123456789abcdef",
  JWT_REFRESH_EXPIRES_IN: "7d",
  BCRYPT_SALT_ROUNDS: "10",
  STORAGE_PROVIDER: "local",
  LOCAL_STORAGE_DIR: path.join(os.tmpdir(), "autoledger-test-storage"),
  PUBLIC_API_BASE_URL: "http://localhost:5000",
  FILE_URL_SECRET: "test-file-url-secret-0011223344556677",
  MAX_UPLOAD_SIZE_MB: "10",
  ENABLE_IN_PROCESS_JOBS: "false",
  JOB_SECRET: "test-job-secret",
  LOG_LEVEL: "error",
};

for (const [k, v] of Object.entries(testDefaults)) {
  if (!process.env[k]) process.env[k] = v;
}

// Vitest loads the project .env into process.env BEFORE this module runs, so
// the "unset" guard above would leave DATABASE_URL pointing at the dev
// database and resetDb() would TRUNCATE real data. Force the test database —
// TEST_DATABASE_URL can still override explicitly.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:password@localhost:5432/autoledger_test";
process.env.NODE_ENV = "test";
