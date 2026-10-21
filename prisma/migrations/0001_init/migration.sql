-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "schedule_status" AS ENUM ('SCHEDULED', 'UPCOMING', 'DUE_TODAY', 'OVERDUE', 'SUBMITTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "bill_status" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION_REQUESTED');

-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION_REQUESTED');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('missing_bill', 'deadline_approaching', 'overdue', 'submitted', 'review_request', 'approved', 'rejected', 'resubmitted', 'correction_requested', 'budget_alert', 'system');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "phone" TEXT,
    "title" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealerships" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dealerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealership_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealership_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'receipt',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bill_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_rules" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "effective_month" DATE NOT NULL,
    "monthly_amount" DECIMAL(14,2) NOT NULL,
    "increase_threshold_percent" DECIMAL(7,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_rule_history" (
    "id" UUID NOT NULL,
    "budget_rule_id" UUID NOT NULL,
    "previous_amount" DECIMAL(14,2) NOT NULL,
    "new_amount" DECIMAL(14,2) NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_rule_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_schedules" (
    "id" UUID NOT NULL,
    "dealership_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "assigned_accountant_id" UUID,
    "billing_period" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "submission_deadline" DATE NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT,
    "status" "schedule_status" NOT NULL DEFAULT 'SCHEDULED',
    "cancelled_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bill_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "bill_reference" TEXT NOT NULL,
    "schedule_id" UUID,
    "dealership_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "billing_period" DATE NOT NULL,
    "billing_date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reference_number" TEXT,
    "document_key" TEXT NOT NULL,
    "original_document_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "bill_status" NOT NULL DEFAULT 'SUBMITTED',
    "resubmission_count" INTEGER NOT NULL DEFAULT 0,
    "accountant_notes" TEXT,
    "admin_notes" TEXT,
    "rejection_reason" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_review_history" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "previous_status" "bill_status",
    "new_status" "bill_status" NOT NULL,
    "decision" "review_decision" NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_review_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" UUID,
    "deduplication_key" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_is_active_idx" ON "users"("role", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "dealerships_code_key" ON "dealerships"("code");

-- CreateIndex
CREATE INDEX "dealerships_is_active_idx" ON "dealerships"("is_active");

-- CreateIndex
CREATE INDEX "dealership_assignments_user_id_idx" ON "dealership_assignments"("user_id");

-- CreateIndex
CREATE INDEX "dealership_assignments_dealership_id_idx" ON "dealership_assignments"("dealership_id");

-- CreateIndex
CREATE UNIQUE INDEX "dealership_assignments_user_id_dealership_id_key" ON "dealership_assignments"("user_id", "dealership_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_categories_name_key" ON "bill_categories"("name");

-- CreateIndex
CREATE INDEX "budget_rules_dealership_id_category_id_effective_month_idx" ON "budget_rules"("dealership_id", "category_id", "effective_month");

-- CreateIndex
CREATE UNIQUE INDEX "budget_rules_dealership_id_category_id_effective_month_key" ON "budget_rules"("dealership_id", "category_id", "effective_month");

-- CreateIndex
CREATE INDEX "budget_rule_history_budget_rule_id_created_at_idx" ON "budget_rule_history"("budget_rule_id", "created_at");

-- CreateIndex
CREATE INDEX "bill_schedules_assigned_accountant_id_submission_deadline_idx" ON "bill_schedules"("assigned_accountant_id", "submission_deadline");

-- CreateIndex
CREATE INDEX "bill_schedules_status_submission_deadline_idx" ON "bill_schedules"("status", "submission_deadline");

-- CreateIndex
CREATE INDEX "bill_schedules_dealership_id_billing_period_idx" ON "bill_schedules"("dealership_id", "billing_period");

-- CreateIndex
CREATE UNIQUE INDEX "bills_bill_reference_key" ON "bills"("bill_reference");

-- CreateIndex
CREATE INDEX "bills_dealership_id_billing_period_idx" ON "bills"("dealership_id", "billing_period");

-- CreateIndex
CREATE INDEX "bills_category_id_billing_period_idx" ON "bills"("category_id", "billing_period");

-- CreateIndex
CREATE INDEX "bills_submitted_at_idx" ON "bills"("submitted_at");

-- CreateIndex
CREATE INDEX "bills_status_idx" ON "bills"("status");

-- CreateIndex
CREATE INDEX "bills_submitted_by_id_idx" ON "bills"("submitted_by_id");

-- CreateIndex
CREATE INDEX "bill_review_history_bill_id_created_at_idx" ON "bill_review_history"("bill_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_read_at_idx" ON "notifications"("recipient_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "dealership_assignments" ADD CONSTRAINT "dealership_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealership_assignments" ADD CONSTRAINT "dealership_assignments_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_rules" ADD CONSTRAINT "budget_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_rule_history" ADD CONSTRAINT "budget_rule_history_budget_rule_id_fkey" FOREIGN KEY ("budget_rule_id") REFERENCES "budget_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_rule_history" ADD CONSTRAINT "budget_rule_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_schedules" ADD CONSTRAINT "bill_schedules_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_schedules" ADD CONSTRAINT "bill_schedules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_schedules" ADD CONSTRAINT "bill_schedules_assigned_accountant_id_fkey" FOREIGN KEY ("assigned_accountant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_schedules" ADD CONSTRAINT "bill_schedules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "bill_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_review_history" ADD CONSTRAINT "bill_review_history_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_review_history" ADD CONSTRAINT "bill_review_history_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AutoLedger additions (not expressible in the Prisma datamodel)
-- ---------------------------------------------------------------------------

-- Case-insensitive unique user emails (application also normalizes to lowercase).
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

-- Case-insensitive unique category names.
CREATE UNIQUE INDEX "bill_categories_name_lower_key" ON "bill_categories" (lower("name"));

-- One ACTIVE schedule per dealership + category + billing period.
CREATE UNIQUE INDEX "bill_schedules_active_unique"
  ON "bill_schedules" ("dealership_id", "category_id", "billing_period")
  WHERE "status" <> 'CANCELLED';

-- One bill per schedule.
CREATE UNIQUE INDEX "bills_schedule_unique"
  ON "bills" ("schedule_id") WHERE "schedule_id" IS NOT NULL;



-- Financial guardrails.
ALTER TABLE "budget_rules"
  ADD CONSTRAINT "budget_rules_amount_nonneg" CHECK ("monthly_amount" >= 0),
  ADD CONSTRAINT "budget_rules_threshold_nonneg" CHECK ("increase_threshold_percent" IS NULL OR "increase_threshold_percent" >= 0);
ALTER TABLE "bills"
  ADD CONSTRAINT "bills_amount_positive" CHECK ("amount" > 0);

-- Idempotent notification deduplication for scheduled jobs.
CREATE UNIQUE INDEX "notifications_dedup_unique"
  ON "notifications" ("deduplication_key") WHERE "deduplication_key" IS NOT NULL;

-- Human-readable bill references: AL-<year>-<seq>.
CREATE SEQUENCE "bill_reference_seq";