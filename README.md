# AutoLedger Backend

Production-oriented REST API for AutoLedger — utility bill management for
automobile dealerships. Node.js + Express + TypeScript + PostgreSQL (Prisma).

## Stack

| Concern        | Choice                                             |
| -------------- | -------------------------------------------------- |
| Runtime        | Node.js 20+, Express 4, TypeScript (strict)        |
| Database       | PostgreSQL via Prisma ORM (migrations in `prisma/`)|
| Auth           | JWT access tokens (15 min) + rotating opaque refresh tokens, bcrypt password hashing (`bcryptjs`) |
| Validation     | Zod (bodies, params, queries)                      |
| Uploads        | Multer (memory), magic-byte signature checks        |
| Storage        | Private object storage — Supabase Storage or local provider with HMAC-signed URLs |
| Security       | Helmet, explicit-allowlist CORS, express-rate-limit |
| Logging        | Pino (redacts auth headers, passwords, tokens)      |
| Tests          | Vitest + Supertest against a real test database     |

## Layout

```
src/
  config/        env validation, Prisma client, storage providers, logger
  middleware/    authenticate, authorizeRole, validate, errorHandler, rateLimiter
  models/        Prisma queries + response DTO serializers
  services/      business logic, transactions, financial calculations
  controllers/   HTTP request/response handling only
  routes/        endpoint wiring + middleware attachment
  schemas/       Zod request schemas
  jobs/          overdue-schedule sweep (idempotent)
  utils/         ApiError, asyncHandler, pagination, date, money
tests/           unit + integration tests (real Postgres)
prisma/          schema.prisma, migrations, seed.ts
```

## Quick start

```powershell
cd server
npm install
cp .env.example .env          # fill in DATABASE_URL etc.
npx prisma migrate deploy
npm run bootstrap:admin -- --email admin@example.com --password 'S3curePass1' --name "Admin"
npm run db:seed               # optional demo data (SEED_DEMO_DATA=true)
npm run dev                   # http://localhost:5000/api/v1
```

### Local Postgres

Any PostgreSQL 14+ works. The compose file is a convenience, not a requirement:

```powershell
docker compose up -d db
# DATABASE_URL=postgresql://postgres:password@localhost:5432/autoledger
```

### First admin

There is **no public admin-registration endpoint**. The first admin is created
via CLI (refuses if an admin already exists); later admins/accountants are
provisioned by an authenticated admin via `POST /api/v1/users`.

### Demo accounts (after `npm run db:seed` with SEED_DEMO_DATA=true)

| Email                     | Password    | Role       | Dealerships        |
| ------------------------- | ----------- | ---------- | ------------------ |
| admin@autoledger.com      | admin123    | ADMIN      | all                |
| accountant@autoledger.com | account123  | ACCOUNTANT | Riverside, Hillcrest |
| lena@autoledger.com       | account123  | ACCOUNTANT | Northgate          |

## Scripts

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | tsx watch dev server |
| `npm run build` | production build → `dist/` |
| `npm start` | run built server |
| `npm run typecheck` / `lint` | `tsc --noEmit` / eslint |
| `npm run prisma:generate` / `prisma:migrate` / `db:seed` | Prisma client / deploy migrations / seed |
| `npm run bootstrap:admin` | first-admin CLI |
| `npm test` / `test:unit` / `test:integration` | Vitest suites |

Integration tests use `TEST_DATABASE_URL` (default
`postgresql://postgres:password@localhost:5432/autoledger_test`) and truncate
all tables per test.

## API overview (`/api/v1`)

- `POST /auth/login` `logout` `refresh` `forgot-password` `reset-password`; `GET /auth/me`
- `GET/POST/PATCH /users`, `PATCH /users/:id/status`, `GET/PUT /users/:id/assignments` — admin only
- `GET/POST/PATCH /dealerships`, `PATCH /dealerships/:id/status`, `GET /dealerships/:id/accountants`
- `GET/POST/PATCH /categories`, `PATCH /categories/:id/status`
- `GET/POST/PATCH /budgets`, `GET /budgets/summary` — **admin only**
- `GET/POST/PATCH /schedules`, `POST /schedules/:id/cancel`
- `GET/POST /bills`, `POST /bills/:id/document`, `POST /bills/:id/resubmit`, `GET /bills/:id/document-url`, `GET /bills/:id/history`, `GET /bills/:id/previous`, `POST /bills/budget-preview`, `GET /bills/:id/budget-comparison` (admin), `POST /bills/:id/review` (admin)
- `POST /documents/scan`, `GET /documents/scans/:id`, `GET /documents/scans/:id/document-url` — bill scanning & extraction (accountant-owned)
- `GET/PATCH /notifications`, `POST /notifications/read-all` — owner-scoped
- `GET /analytics/overview|monthly-spending|dealership-comparison|category-breakdown|submission-completion|budget-vs-actual|export` — **admin only**
- `GET /analytics/my-dashboard` — accountant workflow metrics only
- `GET /health`; `POST /jobs/overdue-sweep` (header `x-job-secret`)

Response envelope: `{ "success": true, "data": ..., "message": ... }` or
`{ "success": false, "error": { "code", "message", "details?" } }`.

### Bill submission (multipart)

`POST /api/v1/bills` — `multipart/form-data` with field `document` (PDF/JPG/PNG)
and field `data` (JSON string):

```json
{"dealershipId":"...","categoryId":"...","scheduleId":"...","billingPeriod":{"month":10,"year":2026},"billingDate":"2026-10-15","amount":1234.56,"referenceNumber":"INV-1"}
```

## Bill scanning (JVVNL smart intake)

`POST /api/v1/documents/scan` (multipart, `document` field) uploads a bill to
private storage, extracts text (`pdf-parse` for digital PDFs, Tesseract OCR for
JPG/PNG when `OCR_PROVIDER=tesseract`), and runs the JVVNL field extractor —
returning a `DocumentScan` with structured fields, per-field confidence and
warnings. Scans expire after `SCAN_RETENTION_HOURS` and belong to the uploader.

`POST /api/v1/bills` then accepts `scanId` instead of a `document` upload — the
scan's stored file becomes the bill document; a scan can be consumed only once.
Optional `consumerNumber`, `meterNumber`, `unitsKwh`, `currentPeriodAmount`,
`previousBillAmount` override extracted values. On submission the server:

- matches the previous bill (same consumer + dealership + category, earlier period),
- computes the budget comparison: `currentPeriodAmount` (else total `amount`)
  vs the dealership+category+billing-month `BudgetRule`,
- blocks duplicate consumer+period submissions.

Accountant responses carry `budgetStatus` only (`within_budget` / `over_budget`
/ `no_budget`); admins get the full figures via `budgetComparison` in the bill
DTO or `GET /bills/:id/budget-comparison`. `POST /bills/budget-preview` returns
status-only for accountants, figures for admins.

Scanned-image PDFs are not rasterized locally — the scan returns a warning to
upload a JPG/PNG or enter manually. Cloud document-AI providers can replace the
`ocrProvider` without touching the submission path.

## Authorization model

Exactly two roles: `ADMIN`, `ACCOUNTANT` (Postgres enum `user_role`).

- Accountants are scoped to their `DealershipAssignment`s — enforced in
  service-level queries, not just the frontend.
- All budget endpoints and all budget-derived analytics are ADMIN-only; review
  responses contain no budget fields.
- Users cannot modify their own role or `isActive`; deactivation revokes all
  refresh tokens; inactive users are denied on every request.
- Document access requires authorization + a short-lived signed URL.

## Financial rules

- `NUMERIC(14,2)` everywhere; `Prisma.Decimal` in code; money is serialized as
  a number only at the DTO boundary.
- **Actual-spending policy:** `actual` = APPROVED bills only; `pending` =
  SUBMITTED / UNDER_REVIEW / CORRECTION_REQUESTED; REJECTED never counts.
  `total`/`recognizedSpend` = approved + pending.
- Aggregations run as SQL `GROUP BY` — no row materialization for totals.
- Budget changes append immutable `budget_rule_history` rows in the same
  transaction.

## Duplicate prevention

- One active schedule per dealership+category+billingPeriod (partial unique
  index, `status <> 'CANCELLED'`).
- One bill per schedule (partial unique index on `schedule_id`).
- Non-scheduled duplicate bills are rejected transactionally under a
  `pg_advisory_xact_lock`; a rejected bill frees the slot (explicit admin
  action = the exception path).

## Scheduled jobs

`runOverdueSweep()` reconciles bill-linked schedules and marks
UPCOMING/DUE_TODAY/OVERDUE, creating deduplicated notifications.

- `ENABLE_IN_PROCESS_JOBS=true` starts an in-process timer — **single instance
  only**. For multi-instance deployments keep it `false` and schedule an
  external cron against `POST /api/v1/jobs/overdue-sweep` with `x-job-secret`.

## Storage

- `STORAGE_PROVIDER=local`: files under `LOCAL_STORAGE_DIR`, served through
  `GET /api/v1/files/:key?e=&s=` HMAC-signed URLs (5 min TTL).
- `STORAGE_PROVIDER=supabase`: private bucket + Supabase signed URLs. Requires
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`.
  Never expose the service-role key to the frontend; if using Supabase
  Postgres, keep RLS enabled and access the DB only through this API.

## Deployment notes

- Build `npm run build`, run `node dist/server.js`; set all env vars from
  `.env.example`; set `FRONTEND_URL` to the deployed origin (CORS allowlist).
- Run `prisma migrate deploy` during release; `DATABASE_URL` = pooled
  connection (Supabase pooler), `DIRECT_URL` = direct for migrations.
- Health check: `GET /api/v1/health` (200 ok / 503 degraded).
- Backups: use the managed Postgres PITR/snapshots (Supabase/Neon) and restore
  via their consoles; keep `bill_reference_seq` and `storage/` or bucket objects
  in the same restore plan.
