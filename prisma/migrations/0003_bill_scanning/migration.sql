-- CreateEnum
CREATE TYPE "document_scan_status" AS ENUM ('PROCESSING', 'EXTRACTED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "budget_comparison_status" AS ENUM ('WITHIN_BUDGET', 'OVER_BUDGET', 'NO_BUDGET');

-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "budget_amount" DECIMAL(14,2),
ADD COLUMN     "budget_comparison_amount" DECIMAL(14,2),
ADD COLUMN     "budget_rule_id" UUID,
ADD COLUMN     "budget_status" "budget_comparison_status",
ADD COLUMN     "consumer_number" TEXT,
ADD COLUMN     "current_period_amount" DECIMAL(14,2),
ADD COLUMN     "extraction_warnings" JSONB,
ADD COLUMN     "meter_number" TEXT,
ADD COLUMN     "previous_bill_amount" DECIMAL(14,2),
ADD COLUMN     "previous_bill_id" UUID,
ADD COLUMN     "scan_id" UUID,
ADD COLUMN     "units_kwh" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "document_scans" (
    "id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "dealership_id" UUID,
    "category_id" UUID,
    "schedule_id" UUID,
    "document_key" TEXT NOT NULL,
    "original_file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "status" "document_scan_status" NOT NULL DEFAULT 'PROCESSING',
    "extraction_method" TEXT,
    "extracted_json" JSONB,
    "confidence_json" JSONB,
    "warnings_json" JSONB,
    "page_count" INTEGER,
    "text_length" INTEGER,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_scans_uploaded_by_id_created_at_idx" ON "document_scans"("uploaded_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bills_scan_id_key" ON "bills"("scan_id");

-- CreateIndex
CREATE INDEX "bills_consumer_number_dealership_id_idx" ON "bills"("consumer_number", "dealership_id");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_previous_bill_id_fkey" FOREIGN KEY ("previous_bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "document_scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_budget_rule_id_fkey" FOREIGN KEY ("budget_rule_id") REFERENCES "budget_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_scans" ADD CONSTRAINT "document_scans_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_scans" ADD CONSTRAINT "document_scans_dealership_id_fkey" FOREIGN KEY ("dealership_id") REFERENCES "dealerships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_scans" ADD CONSTRAINT "document_scans_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "bill_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

