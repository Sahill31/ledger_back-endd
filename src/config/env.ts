import "dotenv/config";
import { z } from "zod";

/** Treat empty .env values as unset for optional fields. */
const emptyToUndefined = <T>(schema: z.ZodType<T>) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

/**
 * Fail-fast environment validation. The process refuses to boot with a clear
 * error listing every missing/invalid variable instead of failing later.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    API_PREFIX: z.string().min(1).default("/api/v1"),
    FRONTEND_URL: z.string().default("http://localhost:5173"),

    DATABASE_URL: z.string().url("DATABASE_URL must be a valid Postgres URL"),
    DIRECT_URL: emptyToUndefined(z.string().url()),

    JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
    JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
    JWT_REFRESH_SECRET: emptyToUndefined(z.string().min(16)),
    JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),

    STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().default("storage"),
    PUBLIC_API_BASE_URL: emptyToUndefined(z.string().url()),
    FILE_URL_SECRET: emptyToUndefined(z.string()),

    SUPABASE_URL: emptyToUndefined(z.string().url()),
    SUPABASE_SERVICE_ROLE_KEY: emptyToUndefined(z.string()),
    SUPABASE_STORAGE_BUCKET: z.string().default("private-bills"),

    MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(10),

    // --- Bill document scanning / extraction ---
    // OCR provider for image uploads: "tesseract" (local, no credentials) or
    // "none" (disables OCR — image scans return a clear manual-entry error).
    OCR_PROVIDER: z.enum(["tesseract", "none"]).default("tesseract"),
    OCR_LANG: z.string().default("eng"),
    OCR_TIMEOUT_MS: z.coerce.number().positive().default(90_000),
    // Hours a scan stays valid for bill submission.
    SCAN_RETENTION_HOURS: z.coerce.number().positive().default(24),
    // Below this many extracted characters a PDF is treated as a scanned image.
    PDF_MIN_TEXT_CHARS: z.coerce.number().positive().default(120),

    ENABLE_IN_PROCESS_JOBS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    JOB_SECRET: z.string().optional(),
    OVERDUE_SWEEP_INTERVAL_MINUTES: z.coerce.number().positive().default(60),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_PROVIDER === "supabase") {
      if (!env.SUPABASE_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUPABASE_URL is required when STORAGE_PROVIDER=supabase" });
      }
      if (!env.SUPABASE_SERVICE_ROLE_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_PROVIDER=supabase" });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  /** Refresh secret falls back to the access secret if not separately set. */
  refreshSecret: parsed.data.JWT_REFRESH_SECRET ?? parsed.data.JWT_ACCESS_SECRET,
  /** Secret used to sign local-storage download URLs. */
  fileUrlSecret:
    parsed.data.FILE_URL_SECRET ??
    parsed.data.JWT_REFRESH_SECRET ??
    parsed.data.JWT_ACCESS_SECRET,
  corsOrigins: parsed.data.FRONTEND_URL.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};

export type Env = typeof env;
