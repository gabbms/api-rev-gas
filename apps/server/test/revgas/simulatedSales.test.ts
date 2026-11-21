import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { simulatedSales } from "../../src/db/schema.js";
import { createRevgasClient } from "../../src/revgas/httpClient.js";
import type { SalePayload } from "../../src/revgas/types.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;

const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

const sale: SalePayload = {
  location: "Rua A",
  number: "1",
  neighborhood: "Centro",
  city: "Teresina",
  state_federation: "PI",
  establishment_id: 2580,
  products: [
    { product_id: 23740, quantity: 2, value: 150 },
    { product_id: 23741, quantity: 1, value: 10 },
  ],
  payments: [{ payment_type: "PIX", value: 310 }],
  channel: "WHATSAPP",
  origin: "INTEGRATION",
  option: "NORMAL",
  broadcast: "NONE",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("createRevgasClient with writes disabled", () => {
  it("simulates the sale in the database without calling the API", async () => {
    const fetchFn = vi.fn();
    const c = createRevgasClient(cfg, db, fetchFn as unknown as typeof fetch);
    const created = await c.createSale(sale);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(created).toMatchObject({ status: "OPEN", total: 310 });
    expect(created.id).toBeGreaterThanOrEqual(900_000_001);
    expect(console.info).toHaveBeenCalledWith("[revgas] escrita desligada: venda simulada");
    const [row] = await db.select().from(simulatedSales);
    expect(row).toMatchObject({ id: created.id, totalCents: 31000, payload: sale });
  });

  it("reads a simulated sale from the database after a restart, without calling RevGás", async () => {
    const before = await createRevgasClient(cfg, db, vi.fn() as unknown as typeof fetch).createSale(sale);
    const fetchFn = vi.fn();
    const restarted = createRevgasClient(cfg, db, fetchFn as unknown as typeof fetch);
    expect(await restarted.getSale(before.id)).toEqual({ id: before.id, status: "OPEN", total: 310 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never repeats a simulated id after a restart", async () => {
    const a = await createRevgasClient(cfg, db, vi.fn() as unknown as typeof fetch).createSale(sale);
    const b = await createRevgasClient(cfg, db, vi.fn() as unknown as typeof fetch).createSale(sale);
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("still reads products and real sales from the API", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/sales/")
        ? json(200, { id: 30930462, status: "CANCEL", total: 110 })
        : json(200, { data: [], pagination: { has_next: false } }),
    );
    const c = createRevgasClient(cfg, db, fetchFn as unknown as typeof fetch);
    await c.listProducts(2580);
    expect(await c.getSale(30930462)).toMatchObject({ status: "CANCEL" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
