import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/client.js";
import { conversations, customerProfiles, handoffs, llmTurns, messages, orderDrafts, simulatedSales } from "../../src/db/schema.js";
import { checkResetAllowed, wipeDemoData } from "../../src/demo/reset.js";
import { createRevgasClient } from "../../src/revgas/httpClient.js";
import { loadConfig } from "../../src/config.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

const dev = "postgres://revgas:revgas@localhost:5433/revgas_bot";
const test = "postgres://revgas:revgas@localhost:5433/revgas_bot_test";

describe("checkResetAllowed", () => {
  it("allows the development database with writes off and APAGAR typed", () => {
    expect(checkResetAllowed({ databaseUrl: dev, databaseUrlTest: test, writeEnabled: false }, "APAGAR")).toBeNull();
  });

  it("refuses while REVGAS_WRITE_ENABLED=true", () => {
    expect(checkResetAllowed({ databaseUrl: dev, databaseUrlTest: test, writeEnabled: true }, "APAGAR")).toMatch(/REVGAS_WRITE_ENABLED/);
  });

  it.each([test, "postgres://revgas:revgas@localhost:5433/revgas_bot_test?sslmode=disable", "postgres://u:p@h/qualquer_test"])(
    "refuses the test database %s",
    (url) => {
      expect(checkResetAllowed({ databaseUrl: url, databaseUrlTest: test, writeEnabled: false }, "APAGAR")).toMatch(/teste/);
    },
  );

  it.each(["", "apagar", "APAGAR ", "sim"])("refuses without the exact confirmation %j", (typed) => {
    expect(checkResetAllowed({ databaseUrl: dev, databaseUrlTest: test, writeEnabled: false }, typed)).toMatch(/APAGAR/);
  });
});

describe("wipeDemoData", () => {
  let db: Db;
  let close: () => Promise<void>;
  const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

  beforeAll(async () => {
    ({ db, close } = await setupTestDb());
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    await resetTables(db);
  });

  it("deletes conversations, messages, AI history, drafts, handoffs, profiles and simulated sales", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const [c] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
    await db.insert(messages).values({ conversationId: c!.id, author: "customer", text: "oi" });
    await db.insert(llmTurns).values({ conversationId: c!.id, role: "user", content: "oi" });
    await db.insert(orderDrafts).values({ conversationId: c!.id, status: "created", payload: {}, totalCents: 1 });
    await db.insert(handoffs).values({ conversationId: c!.id, reason: "x" });
    await db.insert(customerProfiles).values({ phone: "86999998888", name: "Joana" });
    const revgas = createRevgasClient(cfg, db, vi.fn() as unknown as typeof fetch);
    const first = await revgas.createSale({
      location: "R", number: "1", neighborhood: "B", city: "C", state_federation: "PI", establishment_id: 2580,
      products: [{ product_id: 1, quantity: 1, value: 10 }], payments: [{ payment_type: "PIX", value: 10 }],
      channel: "WHATSAPP", origin: "INTEGRATION", option: "NORMAL", broadcast: "NONE",
    });

    const counts = await wipeDemoData(db);

    expect(counts).toEqual({ conversations: 1, messages: 1, llmTurns: 1, orderDrafts: 1, handoffs: 1, customerProfiles: 1, simulatedSales: 1 });
    for (const t of [conversations, messages, llmTurns, orderDrafts, handoffs, customerProfiles, simulatedSales]) {
      expect(await db.select().from(t)).toHaveLength(0);
    }
    // Simulated ids keep growing: a number already shown in a demo is never reused.
    const next = await revgas.createSale({
      location: "R", number: "1", neighborhood: "B", city: "C", state_federation: "PI", establishment_id: 2580,
      products: [{ product_id: 1, quantity: 1, value: 10 }], payments: [{ payment_type: "PIX", value: 10 }],
      channel: "WHATSAPP", origin: "INTEGRATION", option: "NORMAL", broadcast: "NONE",
    });
    expect(next.id).toBeGreaterThan(first.id);
  });
});
