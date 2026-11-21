import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { handoffs, messages, orderDrafts } from "../db/schema.js";

export type MetricsRange = { fromDay: string; toDay: string; start: Date; end: Date };

export type Metrics = {
  from: string;
  to: string;
  /** Sales are simulated while REVGAS_WRITE_ENABLED=false. */
  simulated: boolean;
  /** Conversations with at least one customer message in the period. */
  conversations: number;
  /** Conversations with a sale created in the period and no handoff in the period. */
  botResolved: number;
  /** botResolved / conversations, in %, one decimal. */
  automationRate: number;
  sales: { count: number; totalCents: number; averageTicketCents: number };
  handoffs: { total: number; byReason: { reason: string; count: number }[] };
  /** From a customer message to the next bot message (skipped when an attendant answered first). */
  avgBotResponseMs: number | null;
  /** From the first customer message after the previous sale to the sale. */
  avgTimeToOrderMs: number | null;
};

// America/Fortaleza has no daylight saving time: always UTC-3.
const OFFSET = "-03:00";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

function fortalezaDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(now);
}

function startOf(day: string): Date {
  return new Date(`${day}T00:00:00${OFFSET}`);
}

/** Days are local to Fortaleza and both inclusive; default is today. Throws a message for the user. */
export function parseRange(from?: string, to?: string, now = new Date()): MetricsRange {
  const today = fortalezaDay(now);
  const fromDay = from ?? to ?? today;
  const toDay = to ?? from ?? today;
  if (!DAY.test(fromDay) || !DAY.test(toDay) || Number.isNaN(startOf(fromDay).getTime()) || Number.isNaN(startOf(toDay).getTime())) {
    throw new Error("Datas inválidas: use AAAA-MM-DD");
  }
  const start = startOf(fromDay);
  const end = new Date(startOf(toDay).getTime() + 24 * 3600_000);
  if (end <= start) throw new Error("A data inicial deve ser anterior ou igual à final");
  if ((end.getTime() - start.getTime()) / (24 * 3600_000) > MAX_DAYS) throw new Error(`Período máximo: ${MAX_DAYS} dias`);
  return { fromDay, toDay, start, end };
}

const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

export async function computeMetrics(db: Db, range: MetricsRange, opts: { simulated: boolean }): Promise<Metrics> {
  const { start, end } = range;
  const inPeriod = (col: typeof messages.createdAt) => and(gte(col, start), lt(col, end));

  const active = await db
    .selectDistinct({ id: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.author, "customer"), inPeriod(messages.createdAt)));
  const activeIds = active.map((r) => r.id);

  const sales = await db
    .select({ conversationId: orderDrafts.conversationId, totalCents: orderDrafts.totalCents, at: orderDrafts.updatedAt })
    .from(orderDrafts)
    .where(and(eq(orderDrafts.status, "created"), gte(orderDrafts.updatedAt, start), lt(orderDrafts.updatedAt, end)));

  const periodHandoffs = await db
    .select({ conversationId: handoffs.conversationId, reason: handoffs.reason })
    .from(handoffs)
    .where(and(gte(handoffs.createdAt, start), lt(handoffs.createdAt, end)));

  const handedOff = new Set(periodHandoffs.map((h) => h.conversationId));
  const botResolved = new Set(sales.map((s) => s.conversationId).filter((id) => !handedOff.has(id))).size;
  const totalCents = sales.reduce((sum, s) => sum + s.totalCents, 0);

  const byReason = new Map<string, number>();
  for (const h of periodHandoffs) byReason.set(h.reason, (byReason.get(h.reason) ?? 0) + 1);

  // Timelines of the conversations involved (messages from the period start on, plus earlier sales).
  const ids = [...new Set([...activeIds, ...sales.map((s) => s.conversationId)])];
  const timeline = ids.length
    ? await db
        .select({ conversationId: messages.conversationId, author: messages.author, at: messages.createdAt })
        .from(messages)
        .where(and(inArray(messages.conversationId, ids), lt(messages.createdAt, sql`${end}::timestamptz + interval '1 day'`)))
        .orderBy(asc(messages.createdAt), asc(messages.id))
    : [];
  const byConv = new Map<string, typeof timeline>();
  for (const m of timeline) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);

  const responses: number[] = [];
  for (const list of byConv.values()) {
    list.forEach((m, i) => {
      if (m.author !== "customer" || m.at < start || m.at >= end) return;
      const next = list.slice(i + 1).find((n) => n.author !== "customer");
      if (next?.author === "bot") responses.push(next.at.getTime() - m.at.getTime());
    });
  }

  const allSales = ids.length
    ? await db
        .select({ conversationId: orderDrafts.conversationId, at: orderDrafts.updatedAt })
        .from(orderDrafts)
        .where(and(eq(orderDrafts.status, "created"), inArray(orderDrafts.conversationId, ids)))
        .orderBy(asc(orderDrafts.updatedAt))
    : [];
  const toOrder: number[] = [];
  for (const s of sales) {
    const previous = allSales.filter((p) => p.conversationId === s.conversationId && p.at < s.at).at(-1)?.at;
    const first = (byConv.get(s.conversationId) ?? []).find(
      (m) => m.author === "customer" && (!previous || m.at > previous) && m.at <= s.at,
    );
    if (first) toOrder.push(s.at.getTime() - first.at.getTime());
  }

  return {
    from: range.fromDay,
    to: range.toDay,
    simulated: opts.simulated,
    conversations: activeIds.length,
    botResolved,
    automationRate: activeIds.length ? Math.round((botResolved / activeIds.length) * 1000) / 10 : 0,
    sales: { count: sales.length, totalCents, averageTicketCents: sales.length ? Math.round(totalCents / sales.length) : 0 },
    handoffs: {
      total: periodHandoffs.length,
      byReason: [...byReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    },
    avgBotResponseMs: avg(responses),
    avgTimeToOrderMs: avg(toOrder),
  };
}
