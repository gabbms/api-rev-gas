import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conversations, customerProfiles, orderDrafts } from "../../src/db/schema.js";
import type { Db } from "../../src/db/client.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
});

const payload = { items: [], address: {}, payments: [] };

describe("database schema", () => {
  it("creates a conversation with mode 'bot' by default", async () => {
    const [conv] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
    expect(conv?.mode).toBe("bot");
    expect(conv?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("rejects a second open draft in the same conversation", async () => {
    const [conv] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
    await db.insert(orderDrafts).values({ conversationId: conv!.id, status: "open", payload, totalCents: 100 });
    await expect(
      db.insert(orderDrafts).values({ conversationId: conv!.id, status: "open", payload, totalCents: 100 }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("C1: stores one customer profile per normalized phone", async () => {
    await db.insert(customerProfiles).values({ phone: "86999998888", name: "Maria" });
    const [row] = await db.select().from(customerProfiles);
    expect(row).toMatchObject({ phone: "86999998888", name: "Maria", location: null, hasEmptyCylinder: null, lastSaleId: null });
    await expect(db.insert(customerProfiles).values({ phone: "86999998888" })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows a new open draft once the previous one is no longer open or sending", async () => {
    const [conv] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
    await db.insert(orderDrafts).values({ conversationId: conv!.id, status: "created", payload, totalCents: 100 });
    await db.insert(orderDrafts).values({ conversationId: conv!.id, status: "open", payload, totalCents: 100 });
  });
});
