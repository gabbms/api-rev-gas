import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDeps, ToolContext } from "../../src/agent/agent.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import { createOutgoingRouter } from "../../src/channels/router.js";
import { WhatsAppError } from "../../src/channels/waha/client.js";
import { FakeWhatsAppSender } from "../../src/channels/waha/fakeClient.js";
import {
  ConversationService,
  HANDOFF_TEXT,
  UNSUPPORTED_TEXT,
  type Outgoing,
  type RunTurn,
} from "../../src/conversations/conversationService.js";
import type { Db } from "../../src/db/client.js";
import { asc } from "drizzle-orm";
import { conversations, handoffs, llmTurns, messages, orderDrafts } from "../../src/db/schema.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;
let deps: AgentDeps;
let sent: Outgoing[];
let log: string[];

const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

const send = async (m: Outgoing) => {
  sent.push(m);
  log.push(`send:${m.text}`);
};

function service(runTurn: RunTurn, onChange?: (id: string) => void) {
  return new ConversationService(deps, send, onChange, runTurn);
}

const replying =
  (replyText: string | null, events: ToolContext["events"] = {}): RunTurn =>
  async (ctx) => {
    Object.assign(ctx.events, events);
    return { replyText, events: ctx.events };
  };

async function conversationByPhone(phone: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.phone, phone));
  return row;
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  sent = [];
  log = [];
  const fake = new FakeRevgasClient();
  const catalog = new Catalog(fake, 2580);
  deps = {
    anthropic: {} as Pick<Anthropic, "beta">,
    orders: new OrderService(db, catalog, fake, cfg),
    catalog,
    revgas: fake,
    db,
    cfg,
  };
});

describe("ConversationService", () => {
  it("creates the conversation, stores both messages and sends the reply", async () => {
    await service(replying("Olá! Em que posso ajudar?")).handleCustomerMessage("86999998888", "oi");
    const conv = await conversationByPhone("86999998888");
    expect(conv?.mode).toBe("bot");
    expect(sent).toEqual([
      { conversationId: conv!.id, phone: "86999998888", author: "bot", text: "Olá! Em que posso ajudar?", messageId: expect.any(String) },
    ]);
    const svc = service(replying(null));
    expect((await svc.history(conv!.id)).map((m) => [m.author, m.text])).toEqual([
      ["customer", "oi"],
      ["bot", "Olá! Em que posso ajudar?"],
    ]);
  });

  it("Review Focus 5: does not call the AI or reply while the conversation is with a human", async () => {
    const runTurn = vi.fn(replying("não devia"));
    const svc = service(runTurn);
    const [conv] = await db.insert(conversations).values({ phone: "86999998888", mode: "human" }).returning();
    const changed: string[] = [];
    await new ConversationService(deps, send, (id) => changed.push(id), runTurn).handleCustomerMessage("86999998888", "alô?");
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect((await svc.history(conv!.id)).map((m) => m.text)).toEqual(["alô?"]);
    expect(changed).toContain(conv!.id);
  });

  it("sends the reply, then the official summary, and only then marks it presented", async () => {
    const mark = vi.spyOn(deps.orders, "markPresented").mockImplementation(async () => {
      log.push("markPresented");
    });
    await service(
      replying("Vou te mandar o resumo.", { draftPresentable: { draftId: "d-1", summaryText: "Resumo do pedido: ..." } }),
    ).handleCustomerMessage("86999998888", "quero um botijão, pix");
    expect(log).toEqual(["send:Vou te mandar o resumo.", "send:Resumo do pedido: ...", "markPresented"]);
    expect(mark).toHaveBeenCalledWith("d-1", expect.any(Date));
  });

  it("records every handoff with its reason, for the metrics", async () => {
    const svc = service(replying(null, { handoff: { reason: "Cliente pediu humano" } }));
    await svc.handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    await svc.returnToBot(conv!.id);
    await service(replying(null, { handoff: { reason: "Reclamação" } })).handleCustomerMessage("86999998888", "veio vazando");
    const rows = await db.select().from(handoffs);
    expect(rows.map((r) => [r.conversationId, r.reason])).toEqual([
      [conv!.id, "Cliente pediu humano"],
      [conv!.id, "Reclamação"],
    ]);
  });

  it("hands off to a human and can return to the bot", async () => {
    const svc = service(replying(null, { handoff: { reason: "Cliente pediu humano" } }));
    await svc.handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    expect(conv).toMatchObject({ mode: "human", handoffReason: "Cliente pediu humano" });
    expect(sent.map((m) => m.text)).toEqual([HANDOFF_TEXT]);
    expect(HANDOFF_TEXT).toBe("Vou chamar um atendente para te ajudar. Só um instante!");

    const list = await svc.list();
    expect(list).toEqual([
      expect.objectContaining({ id: conv!.id, phone: "86999998888", mode: "human", handoffReason: "Cliente pediu humano" }),
    ]);
    expect(list[0]!.lastMessageAt).toBeInstanceOf(Date);

    await svc.attendantReply(conv!.id, "Oi, aqui é a Ana.");
    expect(sent.at(-1)).toMatchObject({ author: "attendant", text: "Oi, aqui é a Ana.", phone: "86999998888" });

    await svc.returnToBot(conv!.id);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot", handoffReason: null });
  });

  it("hands off with 'Erro interno' when the agent throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service(async () => {
      throw new Error("boom");
    }).handleCustomerMessage("86999998888", "oi");
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "human", handoffReason: "Erro interno" });
    expect(sent.map((m) => m.text)).toEqual([HANDOFF_TEXT]);
    error.mockRestore();
  });

  it("never runs two agent turns of the same conversation at once", async () => {
    let active = 0;
    let maxActive = 0;
    const runTurn: RunTurn = async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { replyText: "ok", events: ctx.events };
    };
    const svc = service(runTurn);
    await Promise.all([svc.handleCustomerMessage("86999998888", "a"), svc.handleCustomerMessage("86999998888", "b")]);
    expect(maxActive).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("puts differently formatted phones in the same conversation", async () => {
    const svc = service(replying("ok"));
    await svc.handleCustomerMessage("+55 (86) 99999-8888", "a");
    await svc.handleCustomerMessage("86999998888", "b");
    expect(await db.select().from(conversations)).toHaveLength(1);
    expect(sent.every((m) => m.phone === "86999998888")).toBe(true);
  });

  it("ignores an invalid phone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runTurn = vi.fn(replying("x"));
    await service(runTurn).handleCustomerMessage("123", "oi");
    expect(runTurn).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
    warn.mockRestore();
  });

  it("passes the stored RevGás customer id to the agent", async () => {
    await db.insert(conversations).values({ phone: "86999998888", revgasCustomerId: 501 });
    let seen: number | null = null;
    await service(async (ctx) => {
      seen = ctx.customerId;
      return { replyText: null, events: ctx.events };
    }).handleCustomerMessage("86999998888", "oi");
    expect(seen).toBe(501);
  });
});

describe("ConversationService — human period", () => {
  const handoffTurn = replying(null, { handoff: { reason: "Cliente pediu humano" } });

  it("clears the presented summary on handoff, so a 'sim' sent to the human does not confirm it", async () => {
    const svc = service(replying("ok"));
    await svc.handleCustomerMessage("86999998888", "oi");
    const conv = await conversationByPhone("86999998888");
    const [draft] = await db
      .insert(orderDrafts)
      .values({ conversationId: conv!.id, status: "open", payload: {}, totalCents: 1, presentedAt: new Date() })
      .returning();

    await service(handoffTurn).handleCustomerMessage("86999998888", "quero falar com uma pessoa");

    const [row] = await db.select().from(orderDrafts).where(eq(orderDrafts.id, draft!.id));
    expect(row?.presentedAt).toBeNull();
  });

  it("tells the AI what happened with the human when the conversation returns to the bot", async () => {
    const svc = service(replying("Olá!"));
    await svc.handleCustomerMessage("86999998888", "oi");
    await service(handoffTurn).handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    const humanSvc = service(replying("não devia"));
    await humanSvc.handleCustomerMessage("86999998888", "meu gás veio vazado");
    await humanSvc.attendantReply(conv!.id, "Vamos trocar hoje à tarde.");
    const before = await db.select().from(llmTurns).where(eq(llmTurns.conversationId, conv!.id));

    await humanSvc.returnToBot(conv!.id);

    const turns = await db.select().from(llmTurns).where(eq(llmTurns.conversationId, conv!.id)).orderBy(asc(llmTurns.id));
    expect(turns).toHaveLength(before.length + 1);
    const last = turns.at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toContain("[Atendimento humano]");
    expect(blocks[0]!.text).toContain("Cliente: meu gás veio vazado");
    expect(blocks[0]!.text).toContain("Atendente: Vamos trocar hoje à tarde.");
    // Only what happened after the handoff.
    expect(blocks[0]!.text).not.toContain("Cliente: oi");
    expect(blocks[0]!.text).not.toContain("quero falar com uma pessoa");
  });
});

describe("ConversationService — WhatsApp channel", () => {
  let wa: FakeWhatsAppSender;
  const hub = { message: async () => undefined, changed: () => undefined };
  const waService = (runTurn: RunTurn) => new ConversationService(deps, createOutgoingRouter({ db, hub, whatsapp: wa }), undefined, runTurn);
  const fromWhatsApp = (text: string, kind: "text" | "unsupported" = "text", address = "5586999998888") =>
    ({ channel: "whatsapp", address, rawPhone: address, text, kind }) as const;

  beforeEach(() => {
    wa = new FakeWhatsAppSender();
  });

  it("stores the channel and address, and sends the bot's reply to that address", async () => {
    await waService(replying("Olá!")).handleInbound(fromWhatsApp("oi"));
    expect(await conversationByPhone("86999998888")).toMatchObject({ channel: "whatsapp", channelAddress: "5586999998888" });
    expect(wa.sent).toEqual([{ to: "5586999998888", text: "Olá!" }]);
  });

  it("updates the address when WhatsApp reports another one", async () => {
    const svc = waService(replying("ok"));
    await svc.handleInbound(fromWhatsApp("oi"));
    await svc.handleInbound(fromWhatsApp("oi de novo", "text", "+55 86 99999-8888 "));
    expect((await conversationByPhone("86999998888"))?.channelAddress).toBe("5586999998888");
    await db.update(conversations).set({ channelAddress: "old" });
    await svc.handleInbound(fromWhatsApp("e agora"));
    expect((await conversationByPhone("86999998888"))?.channelAddress).toBe("5586999998888");
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  it("the simulated chat sends nothing to WhatsApp", async () => {
    await waService(replying("Olá!")).handleCustomerMessage("86999998888", "oi");
    expect(await conversationByPhone("86999998888")).toMatchObject({ channel: "simulated", channelAddress: null });
    expect(wa.sent).toEqual([]);
  });

  it("refuses a simulated message to a WhatsApp conversation, so nobody writes as a real customer", async () => {
    const runTurn = vi.fn(replying("não devia"));
    const svc = waService(runTurn);
    await svc.handleInbound(fromWhatsApp("oi"));
    runTurn.mockClear();
    wa.sent = [];
    await expect(svc.handleCustomerMessage("86999998888", "sim")).rejects.toThrow("Esta conversa é do WhatsApp; responda pelo painel");
    expect(runTurn).not.toHaveBeenCalled();
    expect(wa.sent).toEqual([]);
  });

  it("an attendant's reply in a WhatsApp conversation goes out through WhatsApp", async () => {
    const svc = waService(replying(null, { handoff: { reason: "Cliente pediu humano" } }));
    await svc.handleInbound(fromWhatsApp("quero falar com uma pessoa"));
    const conv = await conversationByPhone("86999998888");
    await svc.attendantReply(conv!.id, "Oi, aqui é a Ana.");
    expect(wa.sent.map((s) => s.text)).toEqual([HANDOFF_TEXT, "Oi, aqui é a Ana."]);
  });

  it("sends the official summary as the Confirmar / Mudar algo list", async () => {
    vi.spyOn(deps.orders, "markPresented").mockResolvedValue();
    await waService(replying("Vou te mandar o resumo.", { draftPresentable: { draftId: "d", summaryText: "Resumo do pedido:\nTotal: R$ 1,00" } })).handleInbound(
      fromWhatsApp("pix"),
    );
    expect(wa.sent).toEqual([
      { to: "5586999998888", text: "Vou te mandar o resumo." },
      { to: "5586999998888", text: "Resumo do pedido:\nTotal: R$ 1,00", options: ["Confirmar", "Mudar algo"] },
    ]);
  });

  it("a delivery failing twice marks the message failed without breaking the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    wa.failures = [new WhatsAppError("network", "x"), new WhatsAppError("network", "x")];
    await waService(replying("Olá!")).handleInbound(fromWhatsApp("oi"));
    const rows = await db.select().from(messages).orderBy(asc(messages.createdAt));
    expect(rows.map((r) => [r.author, r.deliveryStatus])).toEqual([
      ["customer", null],
      ["bot", "failed"],
    ]);
    const conv = await conversationByPhone("86999998888");
    expect((await waService(replying(null)).history(conv!.id)).at(-1)).toMatchObject({ deliveryStatus: "failed" });
    error.mockRestore();
  });

  it("an audio gets the fixed reply and does not call the AI", async () => {
    const runTurn = vi.fn(replying("não devia"));
    await waService(runTurn).handleInbound(fromWhatsApp("[áudio]", "unsupported"));
    expect(runTurn).not.toHaveBeenCalled();
    expect(UNSUPPORTED_TEXT).toBe("Por enquanto eu entendo só mensagens de texto. Pode escrever o seu pedido?");
    expect(wa.sent).toEqual([{ to: "5586999998888", text: UNSUPPORTED_TEXT }]);
    const conv = await conversationByPhone("86999998888");
    expect((await waService(runTurn).history(conv!.id)).map((m) => m.text)).toEqual(["[áudio]", UNSUPPORTED_TEXT]);
  });

  it("an audio while a human attends gets no automatic reply", async () => {
    await db.insert(conversations).values({ phone: "86999998888", mode: "human", channel: "whatsapp", channelAddress: "5586999998888" });
    await waService(replying("x")).handleInbound(fromWhatsApp("[áudio]", "unsupported"));
    expect(wa.sent).toEqual([]);
  });

  it("lists the channel of each conversation", async () => {
    await waService(replying("ok")).handleInbound(fromWhatsApp("oi"));
    await waService(replying("ok")).handleCustomerMessage("86911112222", "oi");
    const list = await waService(replying(null)).list();
    expect(Object.fromEntries(list.map((c) => [c.phone, c.channel]))).toEqual({ "86999998888": "whatsapp", "86911112222": "simulated" });
  });
});

describe("ConversationService — WhatsApp options and the confirmation gate", () => {
  let wa: FakeWhatsAppSender;
  let fake: FakeRevgasClient;
  const hub = { message: async () => undefined, changed: () => undefined };
  const order = (quantity: number) => ({
    items: [{ productId: 23740, quantity }],
    address: { location: "Rua A", number: "1", neighborhood: "Centro", city: "Teresina", state: "PI" },
    payments: [{ type: "PIX" as const }],
    emptyCylinders: quantity,
  });
  let confirmResults: unknown[];

  // Stands in for the AI: builds the order, re-builds it on a change, and calls confirm on "Confirmar".
  const ai: RunTurn = async (ctx, text) => {
    if (text === "Confirmar") {
      confirmResults.push(await deps.orders.confirm(ctx.conversationId));
      return { replyText: "ok", events: ctx.events };
    }
    const r = await deps.orders.upsertDraft(ctx.conversationId, order(text.includes("2") ? 2 : 1), null);
    if (!r.ok) throw new Error(r.errors.join("; "));
    // A change the AI did not summarize yet (asks something first): the draft stays unpresented.
    if (text.includes("2")) return { replyText: "Certo, 2 botijões. Mais alguma coisa?", events: ctx.events };
    ctx.events.draftPresentable = { draftId: r.draftId!, summaryText: r.summaryText };
    return { replyText: null, events: ctx.events };
  };
  const say = (svc: ConversationService, text: string) =>
    svc.handleInbound({ channel: "whatsapp", address: "5586999998888", rawPhone: "5586999998888", text, kind: "text" });

  beforeEach(() => {
    wa = new FakeWhatsAppSender();
    confirmResults = [];
    fake = new FakeRevgasClient();
    fake.products.push({ id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580 });
    fake.deals.push({ id: 1, product_id: 23740, payment_type: "PIX", suggested_value: 110, minimum_value: null, type: "PAYMENT_TYPE", is_default: false });
    const catalog = new Catalog(fake, 2580);
    deps = { ...deps, catalog, revgas: fake, orders: new OrderService(db, catalog, fake, cfg) };
  });

  it("'Confirmar' tapped on the presented summary creates the sale", async () => {
    const svc = new ConversationService(deps, createOutgoingRouter({ db, hub, whatsapp: wa }), undefined, ai);
    await say(svc, "quero 1 botijão, pix");
    expect(wa.sent.at(-1)?.options).toEqual(["Confirmar", "Mudar algo"]);
    await say(svc, "Confirmar");
    expect(confirmResults).toEqual([{ kind: "created", saleId: expect.any(Number) }]);
    // The fake stands for RevGás here (in the app, REVGAS_WRITE_ENABLED=false turns it into a simulated sale).
    expect(fake.sales).toHaveLength(1);
  });

  it("Review Focus 5: 'Confirmar' from an old summary after the order changed creates no sale", async () => {
    const svc = new ConversationService(deps, createOutgoingRouter({ db, hub, whatsapp: wa }), undefined, ai);
    await say(svc, "quero 1 botijão, pix");
    await say(svc, "na verdade são 2");
    await say(svc, "Confirmar");
    expect(confirmResults).toEqual([{ kind: "not_ready", reason: "not_presented" }]);
    expect(fake.sales).toHaveLength(0);
  });
});

describe("ConversationService — empty AI turn", () => {
  const empty = replying(null);

  it("asks the customer to repeat when the AI returns nothing", async () => {
    await service(empty).handleCustomerMessage("86999998888", "hmm");
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?"]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot" });
  });

  it("hands off with 'IA sem resposta' on the second empty turn in a row", async () => {
    const svc = service(empty);
    await svc.handleCustomerMessage("86999998888", "hmm");
    await svc.handleCustomerMessage("86999998888", "hmm?");
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?", HANDOFF_TEXT]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "human", handoffReason: "IA sem resposta" });
  });

  it("resets the count after a turn with an answer", async () => {
    let n = 0;
    const svc = service(async (ctx) => ({ replyText: n++ === 1 ? "Claro!" : null, events: ctx.events }));
    for (const t of ["a", "b", "c"]) await svc.handleCustomerMessage("86999998888", t);
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?", "Claro!", "Desculpe, não entendi. Pode repetir?"]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot" });
  });

  it("does not treat a turn that only sends the summary as empty", async () => {
    vi.spyOn(deps.orders, "markPresented").mockResolvedValue();
    await service(replying(null, { draftPresentable: { draftId: "d", summaryText: "Resumo do pedido: ..." } })).handleCustomerMessage(
      "86999998888",
      "pix",
    );
    expect(sent.map((m) => m.text)).toEqual(["Resumo do pedido: ..."]);
  });
});
