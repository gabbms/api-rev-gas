import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppError } from "../../src/channels/waha/client.js";
import { FakeWhatsAppSender } from "../../src/channels/waha/fakeClient.js";
import { CHOICES, createOutgoingRouter } from "../../src/channels/router.js";
import type { Outgoing } from "../../src/conversations/conversationService.js";
import type { Db } from "../../src/db/client.js";
import { conversations, messages } from "../../src/db/schema.js";
import { SUMMARY_QUESTION } from "../../src/orders/draft.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;
let wa: FakeWhatsAppSender;
let panel: Outgoing[];
let changed: string[];
const hub = { message: async (m: Outgoing) => void panel.push(m), changed: (id: string) => void changed.push(id) };

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  wa = new FakeWhatsAppSender();
  panel = [];
  changed = [];
});

async function conversation(channel: "simulated" | "whatsapp") {
  const [c] = await db
    .insert(conversations)
    .values(channel === "whatsapp" ? { phone: "86999998888", channel, channelAddress: "5586999998888" } : { phone: "86999998888" })
    .returning();
  return c!;
}

async function outgoing(conversationId: string, text: string, kind?: "summary"): Promise<Outgoing> {
  const [m] = await db.insert(messages).values({ conversationId, author: "bot", text }).returning();
  return { conversationId, phone: "86999998888", author: "bot", text, messageId: m!.id, ...(kind ? { kind } : {}) };
}

const status = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!.deliveryStatus;
const summary = `Resumo do pedido:\n• 1x GLP 13KG — R$ 150,00\nTotal: R$ 150,00\n${SUMMARY_QUESTION}`;

describe("outgoing router", () => {
  it("always tells the panel; a simulated conversation sends nothing to WhatsApp", async () => {
    const c = await conversation("simulated");
    const m = await outgoing(c.id, "Olá!");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(panel).toEqual([m]);
    expect(wa.sent).toEqual([]);
    expect(await status(m.messageId)).toBeNull();
  });

  it("sends a WhatsApp conversation's reply to the stored address and marks it sent", async () => {
    const c = await conversation("whatsapp");
    const m = await outgoing(c.id, "Olá!");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(panel).toEqual([m]);
    expect(wa.sent).toEqual([{ to: "5586999998888", text: "Olá!" }]);
    expect(await status(m.messageId)).toBe("sent");
  });

  it("with WhatsApp off, a WhatsApp conversation only reaches the panel", async () => {
    const c = await conversation("whatsapp");
    const m = await outgoing(c.id, "Olá!");
    await createOutgoingRouter({ db, hub, whatsapp: null })(m);
    expect(panel).toHaveLength(1);
  });

  it("sends the summary as a list with Confirmar / Mudar algo, asking to tap an option", async () => {
    const c = await conversation("whatsapp");
    const m = await outgoing(c.id, summary, "summary");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(CHOICES).toEqual(["Confirmar", "Mudar algo"]);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.options).toEqual(["Confirmar", "Mudar algo"]);
    expect(wa.sent[0]!.text).toContain("Total: R$ 150,00");
    expect(wa.sent[0]!.text).toContain("Toque em *Ver opções* para confirmar ou mudar algo");
    expect(wa.sent[0]!.text).not.toContain(SUMMARY_QUESTION);
    expect(panel[0]!.text).toBe(summary);
  });

  it("falls back to text, with 'Responda *sim*', when the list fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = await conversation("whatsapp");
    wa.failNextWith = new WhatsAppError("unavailable", "501", 501);
    const m = await outgoing(c.id, summary, "summary");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(wa.sent).toEqual([{ to: "5586999998888", text: summary }]);
    expect(summary).toContain("Responda *sim* para confirmar");
    expect(await status(m.messageId)).toBe("sent");
    warn.mockRestore();
  });

  it("retries a network failure once", async () => {
    const c = await conversation("whatsapp");
    wa.failures = [new WhatsAppError("network", "x")];
    const m = await outgoing(c.id, "Olá!");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(wa.sent).toHaveLength(1);
    expect(await status(m.messageId)).toBe("sent");
  });

  it("after two network failures marks the message failed, tells the panel and logs no content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = await conversation("whatsapp");
    wa.failures = [new WhatsAppError("network", "x"), new WhatsAppError("server", "y", 503)];
    const m = await outgoing(c.id, "Seu endereço é Rua Secreta, 10");
    await expect(createOutgoingRouter({ db, hub, whatsapp: wa })(m)).resolves.toBeUndefined();
    expect(wa.sent).toEqual([]);
    expect(await status(m.messageId)).toBe("failed");
    expect(changed).toContain(c.id);
    expect(JSON.stringify(error.mock.calls)).not.toContain("Secreta");
    error.mockRestore();
  });

  it("does not retry an auth error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = await conversation("whatsapp");
    wa.failures = [new WhatsAppError("auth", "401", 401)];
    const m = await outgoing(c.id, "Olá!");
    await createOutgoingRouter({ db, hub, whatsapp: wa })(m);
    expect(wa.failures).toEqual([]);
    expect(wa.sent).toEqual([]);
    expect(await status(m.messageId)).toBe("failed");
    error.mockRestore();
  });
});
