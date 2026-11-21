import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { conversations, handoffs, messages, orderDrafts } from "../../src/db/schema.js";
import { computeMetrics, parseRange } from "../../src/metrics/metrics.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;

// Fortaleza is UTC-3 all year.
const at = (hhmmss: string, day = "2026-11-21") => new Date(`${day}T${hhmmss}-03:00`);

async function conv(phone: string) {
  const [c] = await db.insert(conversations).values({ phone }).returning();
  return c!.id;
}
async function msg(conversationId: string, author: "customer" | "bot" | "attendant", time: Date) {
  await db.insert(messages).values({ conversationId, author, text: "x", createdAt: time });
}
async function sale(conversationId: string, totalCents: number, time: Date, status: "created" | "failed" = "created") {
  await db.insert(orderDrafts).values({ conversationId, status, payload: {}, totalCents, revgasSaleId: 900000001, createdAt: time, updatedAt: time });
}
async function handoff(conversationId: string, reason: string, time: Date) {
  await db.insert(handoffs).values({ conversationId, reason, createdAt: time });
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
});

describe("computeMetrics", () => {
  beforeEach(async () => {
    // A: bot alone, sale at 10:02 (2 min after the first "oi"); replies after 4 s and 6 s.
    const a = await conv("86900000001");
    await msg(a, "customer", at("10:00:00"));
    await msg(a, "bot", at("10:00:04"));
    await msg(a, "customer", at("10:01:00"));
    await msg(a, "bot", at("10:01:06"));
    await sale(a, 16000, at("10:02:00"));
    // B: reply after 2 s, then handed off; the customer message answered by the attendant does not count.
    const b = await conv("86900000002");
    await msg(b, "customer", at("11:00:00"));
    await msg(b, "bot", at("11:00:02"));
    await handoff(b, "Cliente pediu humano", at("11:01:00"));
    await msg(b, "customer", at("11:02:00"));
    await msg(b, "attendant", at("11:03:00"));
    // C: only yesterday — outside the period.
    const c = await conv("86900000003");
    await msg(c, "customer", at("09:00:00", "2026-11-20"));
    await msg(c, "bot", at("09:00:30", "2026-11-20"));
    await sale(c, 99999, at("09:05:00", "2026-11-20"));
    // D: sale with a handoff in the period (not bot-only); reply after 10 s; sale 10 min after the "oi".
    const d = await conv("86900000004");
    await msg(d, "customer", at("11:50:00"));
    await msg(d, "bot", at("11:50:10"));
    await handoff(d, "IA sem resposta", at("11:55:00"));
    await sale(d, 31000, at("12:00:00"));
    await sale(d, 5000, at("12:30:00"), "failed");
  });

  it("computes the cards for the period", async () => {
    const m = await computeMetrics(db, parseRange("2026-11-21", "2026-11-21"), { simulated: true });
    expect(m).toEqual({
      from: "2026-11-21",
      to: "2026-11-21",
      simulated: true,
      conversations: 3,
      botResolved: 1,
      automationRate: 33.3,
      sales: { count: 2, totalCents: 47000, averageTicketCents: 23500 },
      handoffs: {
        total: 2,
        byReason: [
          { reason: "Cliente pediu humano", count: 1 },
          { reason: "IA sem resposta", count: 1 },
        ],
      },
      avgBotResponseMs: 5500,
      avgTimeToOrderMs: 360000,
    });
  });

  it("measures time to order from the first message after the previous sale", async () => {
    const e = await conv("86900000005");
    await msg(e, "customer", at("13:00:00"));
    await sale(e, 1000, at("13:01:00"));
    await msg(e, "customer", at("14:00:00"));
    await sale(e, 1000, at("14:03:00"));
    const m = await computeMetrics(db, parseRange("2026-11-21", "2026-11-21"), { simulated: false });
    // A 120 s, D 600 s, E 60 s and 180 s
    expect(m.avgTimeToOrderMs).toBe(((120 + 600 + 60 + 180) / 4) * 1000);
    expect(m.simulated).toBe(false);
  });

  it("returns zeros and nulls for an empty period", async () => {
    const m = await computeMetrics(db, parseRange("2026-11-25", "2026-11-25"), { simulated: true });
    expect(m).toMatchObject({
      conversations: 0,
      botResolved: 0,
      automationRate: 0,
      sales: { count: 0, totalCents: 0, averageTicketCents: 0 },
      handoffs: { total: 0, byReason: [] },
      avgBotResponseMs: null,
      avgTimeToOrderMs: null,
    });
  });
});

describe("parseRange", () => {
  it("defaults to today in America/Fortaleza", () => {
    // 01:30 UTC on the 22nd is still the 21st in Fortaleza.
    const r = parseRange(undefined, undefined, new Date("2026-11-22T01:30:00Z"));
    expect(r).toEqual({ fromDay: "2026-11-21", toDay: "2026-11-21", start: at("00:00:00"), end: at("00:00:00", "2026-11-22") });
  });

  it("includes the whole 'to' day", () => {
    const r = parseRange("2026-11-01", "2026-11-21");
    expect(r.start).toEqual(at("00:00:00", "2026-11-01"));
    expect(r.end).toEqual(at("00:00:00", "2026-11-22"));
  });

  it.each([
    ["21/11/2026", undefined],
    ["2026-11-21", "2026-11-20"],
    ["2025-01-01", "2026-11-21"],
  ])("rejects an invalid range %s..%s", (from, to) => {
    expect(() => parseRange(from, to)).toThrow();
  });
});

describe("computeMetrics — start of an attendance for the time to order", () => {
  const range = () => parseRange("2026-11-22", "2026-11-22");

  it("counts only from today's message when the conversation has messages from yesterday", async () => {
    const f = await conv("86900000006");
    await msg(f, "customer", at("22:00:00", "2026-11-21")); // yesterday's "oi"
    await msg(f, "bot", at("22:00:05", "2026-11-21"));
    await msg(f, "customer", at("09:00:00", "2026-11-22")); // today: new attendance
    await msg(f, "bot", at("09:00:03", "2026-11-22"));
    await msg(f, "customer", at("09:01:00", "2026-11-22"));
    await sale(f, 16000, at("09:03:00", "2026-11-22"));
    expect((await computeMetrics(db, range(), { simulated: true })).avgTimeToOrderMs).toBe(3 * 60_000);
  });

  it("starts a new attendance after 30 minutes without any message, on the same day", async () => {
    const g = await conv("86900000007");
    await msg(g, "customer", at("10:00:00", "2026-11-22"));
    await msg(g, "bot", at("10:00:02", "2026-11-22"));
    await msg(g, "customer", at("10:30:02", "2026-11-22")); // exactly 30 min after the bot: new attendance
    await sale(g, 16000, at("10:35:02", "2026-11-22"));
    expect((await computeMetrics(db, range(), { simulated: true })).avgTimeToOrderMs).toBe(5 * 60_000);
  });

  it("keeps a pause shorter than 30 minutes inside the same attendance", async () => {
    const h = await conv("86900000008");
    await msg(h, "customer", at("11:00:00", "2026-11-22"));
    await msg(h, "bot", at("11:00:02", "2026-11-22"));
    await msg(h, "customer", at("11:29:00", "2026-11-22"));
    await sale(h, 16000, at("11:30:00", "2026-11-22"));
    expect((await computeMetrics(db, range(), { simulated: true })).avgTimeToOrderMs).toBe(30 * 60_000);
  });

  it("starts after the previous sale even when it was less than 30 minutes ago", async () => {
    const i = await conv("86900000009");
    await msg(i, "customer", at("13:00:00", "2026-11-22"));
    await sale(i, 16000, at("13:01:00", "2026-11-22"));
    await msg(i, "bot", at("13:01:02", "2026-11-22"));
    await msg(i, "customer", at("13:05:00", "2026-11-22"));
    await sale(i, 16000, at("13:08:00", "2026-11-22"));
    // 60 s for the first sale, 180 s for the second
    expect((await computeMetrics(db, range(), { simulated: true })).avgTimeToOrderMs).toBe(120_000);
  });
});
