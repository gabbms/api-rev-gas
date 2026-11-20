import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { conversations, customerProfiles, messages, orderDrafts } from "../../src/db/schema.js";
import type { DraftInput } from "../../src/orders/draft.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { RevgasError } from "../../src/revgas/types.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;
let fake: FakeRevgasClient;
let orders: OrderService;
let conversationId: string;

const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

const input = (quantity = 1): DraftInput => ({
  items: [{ productId: 23740, quantity }],
  address: { location: "Rua das Flores", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" },
  payments: [{ type: "PIX" }],
  hasEmptyCylinder: true,
  customerName: "Maria",
});

const t0 = new Date("2026-11-20T12:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

async function customerSays(text: string, at: Date) {
  await db.insert(messages).values({ conversationId, author: "customer", text, createdAt: at });
}

async function draftStatus(id: string) {
  const [row] = await db.select().from(orderDrafts).where(eq(orderDrafts.id, id));
  return row;
}

/** upsert → presented at t0 → customer replies at t0+1s */
async function readyDraft(): Promise<string> {
  const r = await orders.upsertDraft(conversationId, input(), null);
  if (!r.ok || !r.draftId) throw new Error("draft failed");
  await orders.markPresented(r.draftId, t0);
  await customerSays("sim", later(1000));
  return r.draftId;
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  fake = new FakeRevgasClient();
  fake.products.push({ id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580 });
  fake.deals.push({ id: 1, product_id: 23740, payment_type: "PIX", suggested_value: 110, minimum_value: null, type: "PAYMENT_TYPE", is_default: false });
  orders = new OrderService(db, new Catalog(fake, 2580), fake, cfg);
  const [conv] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
  conversationId = conv!.id;
});

describe("OrderService", () => {
  it("creates exactly one sale on the happy path", async () => {
    const draftId = await readyDraft();
    const result = await orders.confirm(conversationId);
    expect(result).toEqual({ kind: "created", saleId: fake.sales[0]!.id });
    expect(fake.sales).toHaveLength(1);
    expect(fake.sales[0]).toMatchObject({ channel: "WHATSAPP", establishment_id: 2580, broadcast: "NONE" });
    expect(await draftStatus(draftId)).toMatchObject({ status: "created", revgasSaleId: fake.sales[0]!.id });
  });

  it("returns validation errors without saving a draft", async () => {
    const r = await orders.upsertDraft(conversationId, input(0), null);
    expect(r.ok).toBe(false);
    expect(await db.select().from(orderDrafts)).toHaveLength(0);
  });

  it("replaces the open draft instead of creating another", async () => {
    const a = await orders.upsertDraft(conversationId, input(1), null);
    const b = await orders.upsertDraft(conversationId, input(2), null);
    expect(b.draftId).toBe(a.draftId);
    const rows = await db.select().from(orderDrafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totalCents: 22000 });
  });

  it("reports no_draft when there is nothing to confirm", async () => {
    expect(await orders.confirm(conversationId)).toEqual({ kind: "not_ready", reason: "no_draft" });
  });

  it("refuses to confirm a draft that was never presented", async () => {
    await orders.upsertDraft(conversationId, input(), null);
    await customerSays("sim", later(1000));
    expect(await orders.confirm(conversationId)).toEqual({ kind: "not_ready", reason: "not_presented" });
    expect(fake.sales).toHaveLength(0);
  });

  it("refuses to confirm without a customer reply after the summary", async () => {
    const r = await orders.upsertDraft(conversationId, input(), null);
    await customerSays("quero um botijão", later(-1000));
    await orders.markPresented(r.draftId!, t0);
    expect(await orders.confirm(conversationId)).toEqual({ kind: "not_ready", reason: "no_reply_after_summary" });
    expect(fake.sales).toHaveLength(0);
  });

  it("Review Focus 1: two simultaneous confirms create a single sale", async () => {
    await readyDraft();
    const results = await Promise.all([orders.confirm(conversationId), orders.confirm(conversationId)]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toContain("created");
    expect(kinds.filter((k) => k === "created")).toHaveLength(1);
    expect(["in_progress", "already_created"]).toContain(
      results.map((r) => (r.kind === "not_ready" ? r.reason : r.kind)).find((k) => k !== "created"),
    );
    expect(fake.sales).toHaveLength(1);
    expect(await orders.confirm(conversationId)).toEqual({ kind: "already_created", saleId: fake.sales[0]!.id });
    expect(fake.sales).toHaveLength(1);
  });

  it("Review Focus 2: a draft changed after the summary cannot be confirmed with the old yes", async () => {
    await readyDraft();
    await orders.upsertDraft(conversationId, input(2), null);
    expect(await orders.confirm(conversationId)).toEqual({ kind: "not_ready", reason: "not_presented" });
    expect(fake.sales).toHaveLength(0);
  });

  it("Review Focus 3: an uncertain failure is never retried automatically", async () => {
    const draftId = await readyDraft();
    fake.failNextCreateWith = new RevgasError("network");
    expect(await orders.confirm(conversationId)).toEqual({ kind: "uncertain" });
    expect(await draftStatus(draftId)).toMatchObject({ status: "uncertain" });
    const spy = vi.spyOn(fake, "createSale");
    expect(await orders.confirm(conversationId)).toEqual({ kind: "not_ready", reason: "no_draft" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a server error as uncertain", async () => {
    const draftId = await readyDraft();
    fake.failNextCreateWith = new RevgasError("server", "oops", 500);
    expect(await orders.confirm(conversationId)).toEqual({ kind: "uncertain" });
    expect(await draftStatus(draftId)).toMatchObject({ status: "uncertain" });
  });

  it("marks the draft failed when RevGás rejects the sale", async () => {
    const draftId = await readyDraft();
    fake.failNextCreateWith = new RevgasError("invalid", "Endereço inválido", 422);
    expect(await orders.confirm(conversationId)).toEqual({ kind: "rejected", message: "Endereço inválido" });
    expect(await draftStatus(draftId)).toMatchObject({ status: "failed", errorMessage: "Endereço inválido" });
  });

  it("starts a fresh draft after a sale was created", async () => {
    await readyDraft();
    await orders.confirm(conversationId);
    const next = await orders.upsertDraft(conversationId, input(1), null);
    expect(next.ok).toBe(true);
    expect(await db.select().from(orderDrafts)).toHaveLength(2);
  });

  it("returns the latest sale of the conversation", async () => {
    expect(await orders.getLatestSale(conversationId)).toBeNull();
    await readyDraft();
    const created = await orders.confirm(conversationId);
    const sale = await orders.getLatestSale(conversationId);
    expect(sale).toMatchObject({ id: created.kind === "created" ? created.saleId : -1, status: "OPEN" });
  });
});

describe("OrderService — C1: local customer profile", () => {
  const profiles = () => db.select().from(customerProfiles);

  it("saves name, address, cylinder answer and sale id after a created sale", async () => {
    await readyDraft();
    const result = await orders.confirm(conversationId);
    expect(result.kind).toBe("created");
    expect(await profiles()).toEqual([
      expect.objectContaining({
        phone: "86999998888",
        name: "Maria",
        location: "Rua das Flores",
        number: "120",
        neighborhood: "Centro",
        city: "Teresina",
        state: "PI",
        complement: null,
        landmark: null,
        hasEmptyCylinder: true,
        lastSaleId: fake.sales[0]!.id,
      }),
    ]);
  });

  it("updates the existing profile on the next sale, keeping the name when none is given", async () => {
    await db.insert(customerProfiles).values({ phone: "86999998888", name: "Maria", location: "Rua Velha", number: "1" });
    const r = await orders.upsertDraft(
      conversationId,
      { ...input(), customerName: undefined, address: { location: "Rua Nova", number: "2", neighborhood: "Fátima", city: "Teresina", state: "PI" } },
      null,
    );
    await orders.markPresented(r.draftId!, t0);
    await customerSays("sim", later(1000));
    await orders.confirm(conversationId);
    expect(await profiles()).toEqual([expect.objectContaining({ name: "Maria", location: "Rua Nova", number: "2", neighborhood: "Fátima" })]);
  });

  it.each([
    ["rejected", new RevgasError("invalid", "Endereço inválido", 422)],
    ["uncertain", new RevgasError("network")],
  ])("does not touch the profile when the sale is %s", async (_kind, error) => {
    await readyDraft();
    fake.failNextCreateWith = error;
    await orders.confirm(conversationId);
    expect(await profiles()).toHaveLength(0);
  });
});
