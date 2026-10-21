-- Recurring billing rules (template) + task linkage on bill_schedules.
-- Non-destructive: adds a new table, two columns and enum values only.

-- AlterEnum — new task lifecycle statuses.
ALTER TYPE "schedule_status" ADD VALUE 'AWAITING_BILL';
ALTER TYPE "schedule_status" ADD VALUE 'UNDER_REVIEW';

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('MONTHLY');

-- CreateTable
CREATE TABLE "recurring_billing_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dealership_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "assigned_accountant_id" UUID,
    "frequency" "recurrence_frequency" NOT NULL DEFAULT 'MONTHLY',
    "expected_bill_day" INTEGER NOT NULL,
    "submission_deadline_day" INTEGER NOT NULL,
    "deadline_next_month" BOOLEAN NOT NULL DEFAULT false,
    "start_month" DATE NOT NULL,
    "end_month" DATE,
    "reminder_days_before" INTEGER NOT NULL DEFAULT 2,
    "instructions" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recurring_billing_rules_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "bill_schedules" ADD COLUMN "rule_id" UUID;
ALTER TABLE "bill_schedules" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "recurring_billing_rules_is_active_idx" ON "recurring_billing_rules"("is_active");
CREATE INDEX "recurring_billing_rules_dealership_id_category_id_idx" ON "recurring_billing_rules"("dealership_id", "category_id");
CREATE INDEX "recurring_billing_rules_assigned_accountant_id_idx" ON "recurring_billing_rules"("assigned_accountant_id");
CREATE INDEX "bill_schedules_rule_id_billing_period_idx" ON "bill_schedules"("rule_id", "billing_period");

-- AddForeignKey
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_assigned_accountant_id_fkey" FOREIGN KEY ("assigned_accountant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_schedules" ADD CONSTRAINT "bill_schedules_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recurring_billing_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
