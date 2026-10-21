import { BillStatus, Prisma, ScheduleStatus } from "@prisma/client";
import { format } from "date-fns";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { firstOfMonth } from "../utils/date";
import { momChangePercent, moneyToNumber } from "../utils/money";
import type { RequestUser } from "../middleware/authenticate";

/**
 * Analytics & dashboards.
 *
 * Spending policy: `approved` = finalized spend (APPROVED bills);
 * `pending` = awaiting a final decision; `total` = approved + pending.
 * REJECTED bills are excluded everywhere. All aggregates run as SQL
 * GROUP BY / COUNT — no row materialization for totals.
 *
 * Every endpoint here is ADMIN-ONLY except `accountantDashboard`, which is
 * scoped to the caller's assignments and never touches budget data.
 */

const PENDING: BillStatus[] = [BillStatus.SUBMITTED, BillStatus.UNDER_REVIEW, BillStatus.CORRECTION_REQUESTED];

export const analyticsService = {
  async overview() {
    const now = new Date();
    const monthStart = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const threeDaysAgo = new Date(todayUtc - 3 * 864e5);
    const today = new Date(todayUtc);

    const [
      billsThisMonth,
      spendRows,
      awaitingReview,
      overdueCount,
      missingCount,
      pastDueTotal,
      pastDueSubmitted,
      activeDealerships,
      activeAccountants,
      budgetRules,
      budgetSpend,
    ] = await Promise.all([
      prisma.bill.count({ where: { submittedAt: { gte: monthStart } } }),
      prisma.bill.aggregate({
        where: { submittedAt: { gte: monthStart }, status: { not: BillStatus.REJECTED } },
        _sum: { amount: true },
      }),
      prisma.bill.count({ where: { status: { in: PENDING } } }),
      prisma.billSchedule.count({
        where: {
          status: { in: [ScheduleStatus.SCHEDULED, ScheduleStatus.UPCOMING, ScheduleStatus.OVERDUE, ScheduleStatus.DUE_TODAY] },
          submissionDeadline: { lt: today, gte: threeDaysAgo },
          bills: { none: { status: { not: BillStatus.REJECTED } } },
        },
      }),
      prisma.billSchedule.count({
        where: {
          status: { notIn: [ScheduleStatus.CANCELLED, ScheduleStatus.COMPLETED, ScheduleStatus.SUBMITTED] },
          submissionDeadline: { lt: threeDaysAgo },
          bills: { none: { status: { not: BillStatus.REJECTED } } },
        },
      }),
      prisma.billSchedule.count({
        where: { submissionDeadline: { lt: today }, status: { not: ScheduleStatus.CANCELLED } },
      }),
      prisma.billSchedule.count({
        where: {
          submissionDeadline: { lt: today },
          status: { in: [ScheduleStatus.SUBMITTED, ScheduleStatus.COMPLETED] },
        },
      }),
      prisma.dealership.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: "ACCOUNTANT", isActive: true } }),
      prisma.budgetRule.findMany({
        where: { effectiveMonth: monthStart, isActive: true },
        select: { dealershipId: true, categoryId: true, monthlyAmount: true },
      }),
      prisma.bill.groupBy({
        by: ["dealershipId", "categoryId"],
        where: { billingPeriod: monthStart, status: BillStatus.APPROVED },
        _sum: { amount: true },
      }),
    ]);

    const spendByPair = new Map(
      budgetSpend.map((r) => [`${r.dealershipId}:${r.categoryId}`, r._sum.amount ?? new Prisma.Decimal(0)])
    );
    const budgetExceptions = budgetRules.filter((r) =>
      (spendByPair.get(`${r.dealershipId}:${r.categoryId}`) ?? new Prisma.Decimal(0)).gt(r.monthlyAmount)
    ).length;

    return {
      billsThisMonth,
      spendThisMonth: moneyToNumber(spendRows._sum.amount),
      awaitingReview,
      overdueCount,
      missingCount,
      budgetExceptions,
      completionRate: pastDueTotal > 0 ? Math.round((pastDueSubmitted / pastDueTotal) * 100) : 100,
      activeDealerships,
      activeAccountants,
    };
  },

  async monthlySpending(year: number, filters: { dealershipId?: string; categoryId?: string }) {
    const rows = await prisma.bill.groupBy({
      by: ["billingPeriod", "status"],
      where: {
        billingPeriod: { gte: firstOfMonth(year, 1), lte: firstOfMonth(year, 12) },
        status: { not: BillStatus.REJECTED },
        ...(filters.dealershipId ? { dealershipId: filters.dealershipId } : {}),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const byMonth = new Map<number, { approved: Prisma.Decimal; pending: Prisma.Decimal; count: number }>();
    for (const r of rows) {
      const m = r.billingPeriod.getUTCMonth() + 1;
      const acc = byMonth.get(m) ?? { approved: new Prisma.Decimal(0), pending: new Prisma.Decimal(0), count: 0 };
      const amount = r._sum.amount ?? new Prisma.Decimal(0);
      if (r.status === BillStatus.APPROVED) acc.approved = acc.approved.plus(amount);
      else acc.pending = acc.pending.plus(amount);
      acc.count += r._count._all;
      byMonth.set(m, acc);
    }
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const acc = byMonth.get(m);
      return {
        month: m,
        label: format(new Date(Date.UTC(year, i, 1)), "MMM"),
        total: moneyToNumber((acc?.approved ?? new Prisma.Decimal(0)).plus(acc?.pending ?? 0)),
        approved: moneyToNumber(acc?.approved),
        pending: moneyToNumber(acc?.pending),
        count: acc?.count ?? 0,
      };
    });
  },

  async dealershipComparison(filters: { month?: number; year?: number; categoryId?: string }) {
    const where: Prisma.BillWhereInput = { status: { not: BillStatus.REJECTED } };
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.month && filters.year) where.billingPeriod = firstOfMonth(filters.year, filters.month);
    else if (filters.year) where.billingPeriod = { gte: firstOfMonth(filters.year, 1), lte: firstOfMonth(filters.year, 12) };
    const rows = await prisma.bill.groupBy({
      by: ["dealershipId"],
      where,
      _sum: { amount: true },
    });
    const names = await prisma.dealership.findMany({
      where: { id: { in: rows.map((r) => r.dealershipId) } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(names.map((d) => [d.id, d.name]));
    return rows
      .map((r) => ({ name: nameMap.get(r.dealershipId) ?? "Unknown", value: moneyToNumber(r._sum.amount) }))
      .sort((a, b) => b.value - a.value);
  },

  async categoryBreakdown(filters: { month?: number; year?: number; dealershipId?: string; categoryId?: string }) {
    const where: Prisma.BillWhereInput = { status: { not: BillStatus.REJECTED } };
    if (filters.dealershipId) where.dealershipId = filters.dealershipId;
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.month && filters.year) where.billingPeriod = firstOfMonth(filters.year, filters.month);
    else if (filters.year) where.billingPeriod = { gte: firstOfMonth(filters.year, 1), lte: firstOfMonth(filters.year, 12) };
    const rows = await prisma.bill.groupBy({
      by: ["categoryId"],
      where,
      _sum: { amount: true },
    });
    const names = await prisma.billCategory.findMany({
      where: { id: { in: rows.map((r) => r.categoryId) } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(names.map((c) => [c.id, c.name]));
    return rows
      .map((r) => ({ name: nameMap.get(r.categoryId) ?? "Other", value: moneyToNumber(r._sum.amount) }))
      .sort((a, b) => b.value - a.value);
  },

  /** Per-month submission outcomes for the past N months + status breakdown. */
  async submissionCompletion(months = 6, dealershipId?: string, categoryId?: string) {
    const now = new Date();
    const trend: { label: string; submitted: number; overdueOrMissing: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const start = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1 - i);
      const end = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 2 - i);
      const where: Prisma.BillScheduleWhereInput = {
        submissionDeadline: { gte: start, lt: end },
        status: { not: ScheduleStatus.CANCELLED },
        ...(dealershipId ? { dealershipId } : {}),
      };
      const [submitted, overdueOrMissing] = await Promise.all([
        prisma.billSchedule.count({
          where: { ...where, status: { in: [ScheduleStatus.SUBMITTED, ScheduleStatus.COMPLETED] } },
        }),
        prisma.billSchedule.count({
          where: {
            ...where,
            status: { notIn: [ScheduleStatus.CANCELLED, ScheduleStatus.SUBMITTED, ScheduleStatus.COMPLETED] },
            submissionDeadline: { lt: now },
          },
        }),
      ]);
      trend.push({ label: format(start, "MMM"), submitted, overdueOrMissing });
    }
    const statusRows = await prisma.bill.groupBy({
      by: ["status"],
      where: {
        ...(dealershipId ? { dealershipId } : {}),
        ...(categoryId ? { categoryId } : {}),
      },
      _count: { _all: true },
    });
    const labels: Record<BillStatus, string> = {
      SUBMITTED: "Submitted",
      UNDER_REVIEW: "Under review",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      CORRECTION_REQUESTED: "Correction requested",
    };
    const breakdown = statusRows.map((r) => ({
      name: labels[r.status],
      value: r._count._all,
    }));
    return { trend, breakdown };
  },

  /**
   * Budget vs actual per dealership+category for a month, incl.
   * month-over-month change. Missing/zero baselines return null, not fiction.
   */
  async budgetVsActual(month: number, year: number) {
    const period = firstOfMonth(year, month);
    const prev = firstOfMonth(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);

    const [rules, actuals, prevActuals] = await Promise.all([
      prisma.budgetRule.findMany({
        where: { effectiveMonth: period, isActive: true },
        include: {
          dealership: { select: { name: true } },
          category: { select: { name: true } },
        },
      }),
      prisma.bill.groupBy({
        by: ["dealershipId", "categoryId"],
        where: { billingPeriod: period, status: BillStatus.APPROVED },
        _sum: { amount: true },
      }),
      prisma.bill.groupBy({
        by: ["dealershipId", "categoryId"],
        where: { billingPeriod: prev, status: BillStatus.APPROVED },
        _sum: { amount: true },
      }),
    ]);

    const cur = new Map(actuals.map((r) => [`${r.dealershipId}:${r.categoryId}`, r._sum.amount ?? new Prisma.Decimal(0)]));
    const previous = new Map(prevActuals.map((r) => [`${r.dealershipId}:${r.categoryId}`, r._sum.amount ?? new Prisma.Decimal(0)]));

    return rules.map((r) => {
      const key = `${r.dealershipId}:${r.categoryId}`;
      const actual = cur.get(key) ?? new Prisma.Decimal(0);
      const prevSpend = previous.get(key);
      const remaining = r.monthlyAmount.minus(actual);
      return {
        budgetRuleId: r.id,
        dealershipId: r.dealershipId,
        dealershipName: r.dealership.name,
        categoryId: r.categoryId,
        categoryName: r.category.name,
        budget: moneyToNumber(r.monthlyAmount),
        actual: moneyToNumber(actual),
        remaining: moneyToNumber(remaining),
        utilization: r.monthlyAmount.gt(0) ? actual.div(r.monthlyAmount).mul(100).toDecimalPlaces(2).toNumber() : 0,
        overBudget: remaining.lt(0) ? moneyToNumber(remaining.abs()) : 0,
        monthOverMonthChange: momChangePercent(actual, prevSpend ?? null),
      };
    });
  },

  /**
   * Admin expenditure report — budget vs actual for a dealership/category/
   * billing-month scope.
   *
   * Accounting basis (kept identical to the per-bill budget comparison):
   * expenditure = COALESCE(current_period_amount, amount) — the current-period
   * charge when extracted, else the bill's total payable. `amount` itself is
   * reported separately as totalPayable.
   *
   * Inclusion rules: APPROVED bills → official expenditure; SUBMITTED /
   * UNDER_REVIEW → pending review; CORRECTION_REQUESTED → awaiting correction;
   * REJECTED → excluded from expenditure, reported as informational.
   * Resubmissions update the same Bill row, so nothing is double-counted.
   */
  async expenditureReport(filters: {
    dealershipId?: string;
    categoryId?: string;
    month: number;
    year: number;
    reviewStatus?: BillStatus;
    comparePrevious?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const period = firstOfMonth(filters.year, filters.month);
    const scope = {
      dealershipId: filters.dealershipId ?? null,
      categoryId: filters.categoryId ?? null,
    };

    // ---- Status aggregates (single SQL pass, Decimal sums) ----------------
    const statusRows = await prisma.$queryRaw<
      {
        status: BillStatus;
        bill_count: bigint;
        expenditure: Prisma.Decimal;
        total_payable: Prisma.Decimal;
      }[]
    >`
      SELECT status,
             COUNT(*)::bigint                          AS bill_count,
             COALESCE(SUM(COALESCE(current_period_amount, amount)), 0) AS expenditure,
             COALESCE(SUM(amount), 0)                  AS total_payable
      FROM bills
      WHERE billing_period = ${period}::date
        AND (${scope.dealershipId}::uuid IS NULL OR dealership_id = ${scope.dealershipId}::uuid)
        AND (${scope.categoryId}::uuid  IS NULL OR category_id  = ${scope.categoryId}::uuid)
      GROUP BY status`;

    const agg = {
      approved: { expenditure: new Prisma.Decimal(0), payable: new Prisma.Decimal(0), count: 0 },
      pendingReview: { expenditure: new Prisma.Decimal(0), payable: new Prisma.Decimal(0), count: 0 },
      correction: { expenditure: new Prisma.Decimal(0), payable: new Prisma.Decimal(0), count: 0 },
      rejected: { expenditure: new Prisma.Decimal(0), payable: new Prisma.Decimal(0), count: 0 },
    };
    for (const r of statusRows) {
      const bucket =
        r.status === BillStatus.APPROVED
          ? agg.approved
          : r.status === BillStatus.REJECTED
            ? agg.rejected
            : r.status === BillStatus.CORRECTION_REQUESTED
              ? agg.correction
              : agg.pendingReview;
      bucket.expenditure = bucket.expenditure.plus(r.expenditure);
      bucket.payable = bucket.payable.plus(r.total_payable);
      bucket.count += Number(r.bill_count);
    }

    // ---- Applicable budgets (effective month = billing period) ------------
    const budgetRules = await prisma.budgetRule.findMany({
      where: {
        effectiveMonth: period,
        isActive: true,
        ...(scope.dealershipId ? { dealershipId: scope.dealershipId } : {}),
        ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
      },
      select: { id: true, dealershipId: true, categoryId: true, monthlyAmount: true },
    });
    const budgetTotal = budgetRules.reduce(
      (sum, r) => sum.plus(r.monthlyAmount),
      new Prisma.Decimal(0)
    );

    // ---- Per dealership+category comparison rows --------------------------
    const [dealershipNames, categoryNames] = await Promise.all([
      prisma.dealership.findMany({ select: { id: true, name: true, code: true } }),
      prisma.billCategory.findMany({ select: { id: true, name: true } }),
    ]);
    const dName = new Map(dealershipNames.map((d) => [d.id, d.name]));
    const cName = new Map(categoryNames.map((c) => [c.id, c.name]));

    // Approved expenditure per pair (COALESCE basis, same SQL semantics).
    const pairRows = await prisma.$queryRaw<
      { dealership_id: string; category_id: string; expenditure: Prisma.Decimal }[]
    >`
      SELECT dealership_id, category_id,
             COALESCE(SUM(COALESCE(current_period_amount, amount)), 0) AS expenditure
      FROM bills
      WHERE billing_period = ${period}::date
        AND status = 'APPROVED'
        AND (${scope.dealershipId}::uuid IS NULL OR dealership_id = ${scope.dealershipId}::uuid)
        AND (${scope.categoryId}::uuid  IS NULL OR category_id  = ${scope.categoryId}::uuid)
      GROUP BY dealership_id, category_id`;

    type PairStatus =
      | "within_budget"
      | "exceeded"
      | "no_budget"
      | "zero_budget"
      | "no_expenditure";
    const pairs = new Map<
      string,
      { dealershipId: string; categoryId: string; budget: Prisma.Decimal | null; actual: Prisma.Decimal }
    >();
    for (const r of budgetRules) {
      const key = `${r.dealershipId}:${r.categoryId}`;
      const row = pairs.get(key) ?? {
        dealershipId: r.dealershipId,
        categoryId: r.categoryId,
        budget: new Prisma.Decimal(0),
        actual: new Prisma.Decimal(0),
      };
      row.budget = (row.budget ?? new Prisma.Decimal(0)).plus(r.monthlyAmount);
      pairs.set(key, row);
    }
    for (const r of pairRows) {
      const key = `${r.dealership_id}:${r.category_id}`;
      const row = pairs.get(key) ?? {
        dealershipId: r.dealership_id,
        categoryId: r.category_id,
        budget: null,
        actual: new Prisma.Decimal(0),
      };
      row.actual = row.actual.plus(r.expenditure);
      pairs.set(key, row);
    }

    const classify = (budget: Prisma.Decimal | null, actual: Prisma.Decimal): PairStatus => {
      if (budget === null) return "no_budget";
      if (budget.lte(0)) return "zero_budget";
      if (actual.lte(0)) return "no_expenditure";
      return actual.lte(budget) ? "within_budget" : "exceeded";
    };

    const comparisons = [...pairs.values()]
      .map((p) => {
        const remaining = p.budget !== null ? p.budget.minus(p.actual) : null;
        return {
          dealershipId: p.dealershipId,
          dealershipName: dName.get(p.dealershipId) ?? "Unknown",
          categoryId: p.categoryId,
          categoryName: cName.get(p.categoryId) ?? "Unknown",
          budget: p.budget === null ? null : moneyToNumber(p.budget),
          actual: moneyToNumber(p.actual),
          remaining:
            remaining !== null && remaining.gte(0) ? moneyToNumber(remaining) : null,
          exceeded:
            remaining !== null && remaining.lt(0) ? moneyToNumber(remaining.abs()) : null,
          utilization:
            p.budget !== null && p.budget.gt(0)
              ? p.actual.div(p.budget).mul(100).toDecimalPlaces(2).toNumber()
              : null,
          status: classify(p.budget, p.actual) as PairStatus,
        };
      })
      .sort((a, b) => b.actual - a.actual);

    // ---- Monthly trend for the report year (same scope) -------------------
    const [budgetTrendRows, spendTrendRows] = await Promise.all([
      prisma.budgetRule.groupBy({
        by: ["effectiveMonth"],
        where: {
          effectiveMonth: { gte: firstOfMonth(filters.year, 1), lte: firstOfMonth(filters.year, 12) },
          isActive: true,
          ...(scope.dealershipId ? { dealershipId: scope.dealershipId } : {}),
          ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
        },
        _sum: { monthlyAmount: true },
      }),
      prisma.$queryRaw<{ period: Date; expenditure: Prisma.Decimal; pending: Prisma.Decimal }[]>`
        SELECT billing_period AS period,
               COALESCE(SUM(COALESCE(current_period_amount, amount)) FILTER (WHERE status = 'APPROVED'), 0) AS expenditure,
               COALESCE(SUM(COALESCE(current_period_amount, amount)) FILTER (WHERE status IN ('SUBMITTED','UNDER_REVIEW')), 0) AS pending
        FROM bills
        WHERE billing_period >= ${firstOfMonth(filters.year, 1)}::date
          AND billing_period <= ${firstOfMonth(filters.year, 12)}::date
          AND status <> 'REJECTED'
          AND (${scope.dealershipId}::uuid IS NULL OR dealership_id = ${scope.dealershipId}::uuid)
          AND (${scope.categoryId}::uuid  IS NULL OR category_id  = ${scope.categoryId}::uuid)
        GROUP BY billing_period`,
    ]);
    const budgetByMonth = new Map(
      budgetTrendRows.map((r) => [r.effectiveMonth.getUTCMonth() + 1, r._sum.monthlyAmount ?? new Prisma.Decimal(0)])
    );
    const spendByMonth = new Map(
      spendTrendRows.map((r) => [r.period.getUTCMonth() + 1, r])
    );
    const trend = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const spend = spendByMonth.get(m);
      return {
        month: m,
        label: format(new Date(Date.UTC(filters.year, i, 1)), "MMM"),
        // null, not 0 — a month without a configured budget is not a zero budget.
        budget: budgetByMonth.has(m) ? moneyToNumber(budgetByMonth.get(m)) : null,
        actual: moneyToNumber(spend?.expenditure),
        pending: moneyToNumber(spend?.pending),
      };
    });

    // ---- Summary classification -------------------------------------------
    const hasBudget = budgetRules.length > 0 && budgetTotal.gt(0);
    const actual = agg.approved.expenditure;
    const summaryStatus = !hasBudget
      ? "no_budget"
      : actual.lte(0)
        ? agg.pendingReview.count > 0 || agg.correction.count > 0
          ? "pending_only"
          : "no_expenditure"
        : actual.lte(budgetTotal)
          ? "within_budget"
          : "exceeded";

    // ---- Detailed bill rows (paginated) ------------------------------------
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
    const billWhere: Prisma.BillWhereInput = {
      billingPeriod: period,
      ...(scope.dealershipId ? { dealershipId: scope.dealershipId } : {}),
      ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
      ...(filters.reviewStatus ? { status: filters.reviewStatus } : {}),
    };
    const [bills, totalBills] = await Promise.all([
      prisma.bill.findMany({
        where: billWhere,
        include: {
          dealership: { select: { name: true, code: true } },
          category: { select: { name: true } },
          submittedBy: { select: { fullName: true } },
        },
        orderBy: [{ submittedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.bill.count({ where: billWhere }),
    ]);
    const pairStatusByKey = new Map(comparisons.map((c) => [`${c.dealershipId}:${c.categoryId}`, c.status]));
    const billRows = bills.map((b) => ({
      id: b.id,
      billReference: b.billReference,
      scheduleId: b.scheduleId,
      dealershipId: b.dealershipId,
      dealershipName: b.dealership.name,
      dealershipCode: b.dealership.code,
      categoryId: b.categoryId,
      categoryName: b.category.name,
      billingPeriod: {
        month: b.billingPeriod.getUTCMonth() + 1,
        year: b.billingPeriod.getUTCFullYear(),
      },
      billingDate: b.billingDate.toISOString(),
      submittedAt: b.submittedAt.toISOString(),
      submittedByName: b.submittedBy.fullName,
      expenditureAmount: moneyToNumber(b.currentPeriodAmount ?? b.amount),
      totalPayable: moneyToNumber(b.amount),
      status: b.status,
      // The bill's stored snapshot wins; fall back to the pair classification.
      budgetStatus:
        b.budgetStatus ??
        (pairStatusByKey.get(`${b.dealershipId}:${b.categoryId}`) ?? "no_budget"),
    }));

    // ---- Optional previous-period comparison ------------------------------
    let previousPeriod: {
      month: number;
      year: number;
      budget: number | null;
      actualExpenditure: number;
      status: string;
    } | null = null;
    if (filters.comparePrevious) {
      const prevMonth = filters.month === 1 ? 12 : filters.month - 1;
      const prevYear = filters.month === 1 ? filters.year - 1 : filters.year;
      const prevPeriod = firstOfMonth(prevYear, prevMonth);
      const [prevAgg, prevRules] = await Promise.all([
        prisma.$queryRaw<{ expenditure: Prisma.Decimal }[]>`
          SELECT COALESCE(SUM(COALESCE(current_period_amount, amount)), 0) AS expenditure
          FROM bills
          WHERE billing_period = ${prevPeriod}::date
            AND status = 'APPROVED'
            AND (${scope.dealershipId}::uuid IS NULL OR dealership_id = ${scope.dealershipId}::uuid)
            AND (${scope.categoryId}::uuid  IS NULL OR category_id  = ${scope.categoryId}::uuid)`,
        prisma.budgetRule.aggregate({
          where: {
            effectiveMonth: prevPeriod,
            isActive: true,
            ...(scope.dealershipId ? { dealershipId: scope.dealershipId } : {}),
            ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
          },
          _sum: { monthlyAmount: true },
        }),
      ]);
      const prevBudget = prevRules._sum.monthlyAmount ?? new Prisma.Decimal(0);
      const prevActual = prevAgg[0]?.expenditure ?? new Prisma.Decimal(0);
      previousPeriod = {
        month: prevMonth,
        year: prevYear,
        budget: prevBudget.gt(0) ? moneyToNumber(prevBudget) : null,
        actualExpenditure: moneyToNumber(prevActual),
        status: !prevBudget.gt(0)
          ? "no_budget"
          : prevActual.lte(0)
            ? "no_expenditure"
            : prevActual.lte(prevBudget)
              ? "within_budget"
              : "exceeded",
      };
    }

    return {
      filters: {
        dealershipId: scope.dealershipId,
        categoryId: scope.categoryId,
        month: filters.month,
        year: filters.year,
        reviewStatus: filters.reviewStatus ?? null,
      },
      summary: {
        status: summaryStatus,
        budget: hasBudget ? moneyToNumber(budgetTotal) : null,
        actualExpenditure: moneyToNumber(actual),
        approvedTotalPayable: moneyToNumber(agg.approved.payable),
        approvedBillCount: agg.approved.count,
        remainingBudget: hasBudget && budgetTotal.gte(actual) ? moneyToNumber(budgetTotal.minus(actual)) : null,
        exceededAmount: hasBudget && actual.gt(budgetTotal) ? moneyToNumber(actual.minus(budgetTotal)) : null,
        utilizationPercentage:
          hasBudget && budgetTotal.gt(0)
            ? actual.div(budgetTotal).mul(100).toDecimalPlaces(2).toNumber()
            : null,
        projectedExpenditure: moneyToNumber(
          actual.plus(agg.pendingReview.expenditure).plus(agg.correction.expenditure)
        ),
        pendingReview: {
          amount: moneyToNumber(agg.pendingReview.expenditure),
          count: agg.pendingReview.count,
        },
        correctionRequested: {
          amount: moneyToNumber(agg.correction.expenditure),
          count: agg.correction.count,
        },
        rejected: {
          amount: moneyToNumber(agg.rejected.payable),
          count: agg.rejected.count,
        },
        totalBillCount:
          agg.approved.count + agg.pendingReview.count + agg.correction.count + agg.rejected.count,
      },
      comparisons,
      trend,
      previousPeriod,
      bills: {
        items: billRows,
        page,
        pageSize,
        total: totalBills,
      },
    };
  },

  /**
   * CSV export. `kind`: bills | budgets | spending.
   */
  async exportCsv(kind: string, filters: { month?: number; year?: number }): Promise<string> {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const toCsv = (headers: string[], rows: unknown[][]) =>
      [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");

    if (kind === "bills") {
      const where: Prisma.BillWhereInput = {};
      if (filters.month && filters.year) where.billingPeriod = firstOfMonth(filters.year, filters.month);
      const bills = await prisma.bill.findMany({
        where,
        include: {
          dealership: { select: { name: true, code: true } },
          category: { select: { name: true } },
          submittedBy: { select: { fullName: true } },
        },
        orderBy: { submittedAt: "desc" },
      });
      return toCsv(
        ["reference", "dealership", "code", "category", "amount", "currency", "billing_period", "billing_date", "status", "submitted_by", "submitted_at"],
        bills.map((b) => [
          b.billReference,
          b.dealership.name,
          b.dealership.code,
          b.category.name,
          b.amount.toFixed(2),
          b.currency,
          b.billingPeriod.toISOString().slice(0, 10),
          b.billingDate.toISOString().slice(0, 10),
          b.status,
          b.submittedBy.fullName,
          b.submittedAt.toISOString(),
        ])
      );
    }
    if (kind === "budgets") {
      const month = filters.month ?? new Date().getUTCMonth() + 1;
      const year = filters.year ?? new Date().getUTCFullYear();
      const rows = await this.budgetVsActual(month, year);
      return toCsv(
        ["dealership", "category", "budget", "actual", "remaining", "utilization_pct", "over_budget", "mom_change_pct"],
        rows.map((r) => [r.dealershipName, r.categoryName, r.budget, r.actual, r.remaining, r.utilization, r.overBudget, r.monthOverMonthChange ?? ""])
      );
    }
    if (kind === "spending") {
      const year = filters.year ?? new Date().getUTCFullYear();
      const rows = await this.monthlySpending(year, {});
      return toCsv(
        ["month", "label", "total", "approved", "pending", "bill_count"],
        rows.map((r) => [r.month, r.label, r.total, r.approved, r.pending, r.count])
      );
    }
    throw ApiError.badRequest("Unknown export type. Use bills, budgets or spending.");
  },

  /**
   * Accountant dashboard — scoped to the caller's assigned dealerships and
   * own workflow metrics only. Contains NO budget data by construction.
   */
  async accountantDashboard(user: RequestUser) {
    if (user.role !== "ACCOUNTANT") throw ApiError.forbidden();
    const dealershipIds = user.dealershipIds;
    const todayUtc = new Date();
    const today = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate()));
    const soon = new Date(today.getTime() + 7 * 864e5);
    const threeDaysAgo = new Date(today.getTime() - 3 * 864e5);

    const schedules = await prisma.billSchedule.findMany({
      where: {
        dealershipId: { in: dealershipIds },
        status: { notIn: [ScheduleStatus.CANCELLED, ScheduleStatus.SUBMITTED, ScheduleStatus.COMPLETED] },
        OR: [{ assignedAccountantId: null }, { assignedAccountantId: user.id }],
      },
      select: { submissionDeadline: true },
    });
    let dueSoon = 0, overdue = 0;
    for (const s of schedules) {
      if (s.submissionDeadline < threeDaysAgo || s.submissionDeadline < today) overdue += 1;
      else if (s.submissionDeadline <= soon) dueSoon += 1;
    }

    const bills = await prisma.bill.groupBy({
      by: ["status"],
      where: { dealershipId: { in: dealershipIds } },
      _count: { _all: true },
    });
    const count = (st: BillStatus[]) =>
      bills.filter((b) => st.includes(b.status)).reduce((s, b) => s + b._count._all, 0);

    return {
      dueSoon,
      overdue,
      awaitingSubmission: schedules.length,
      awaitingReview: count(PENDING),
      approved: count([BillStatus.APPROVED]),
      rejected: count([BillStatus.REJECTED]),
      assignedDealerships: dealershipIds.length,
    };
  },
};

