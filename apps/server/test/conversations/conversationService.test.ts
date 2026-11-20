import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDeps, ToolContext } from "../../src/agent/agent.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import {
  ConversationService,
  HANDOFF_TEXT,
  type Outgoing,
  type RunTurn,
} from "../../src/conversations/conversationService.js";
import type { Db } from "../../src/db/client.js";
import { conversations, messages } from "../../src/db/schema.js";
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
    expect(sent).toEqual([{ conversationId: conv!.id, phone: "86999998888", author: "bot", text: "Olá! Em que posso ajudar?" }]);
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
