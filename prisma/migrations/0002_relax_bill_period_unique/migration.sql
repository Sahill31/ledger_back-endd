-- The (dealership, category, period) hard-unique index was too strict:
-- dealerships may legitimately have several bills for one category+period
-- (e.g. multiple meters/accounts). Uniqueness for the strictest case is still
-- enforced by bills_schedule_unique; non-scheduled duplicates are prevented
-- transactionally under a pg_advisory_xact_lock in bill.service (a REJECTED
-- bill frees the slot ? the explicit admin-action exception path).
DROP INDEX IF EXISTS "bills_active_period_unique";
