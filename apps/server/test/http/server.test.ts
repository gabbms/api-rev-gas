import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDeps } from "../../src/agent/agent.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import { ConversationService, type RunTurn } from "../../src/conversations/conversationService.js";
import type { Db } from "../../src/db/client.js";
import { conversations, llmTurns } from "../../src/db/schema.js";
import { Hub, buildServer } from "../../src/http/server.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

const REVGAS_KEY = "revgas-secret-value-xyz";
const ANTHROPIC_KEY = "anthropic-secret-value-abc";
const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: REVGAS_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY });

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
const seen: string[] = [];

const runTurn: RunTurn = async (ctx) => ({ replyText: "Olá! Em que posso ajudar?", events: ctx.events });

function nextMessage(ws: { once(event: "message", cb: (data: unknown) => void): unknown }, type: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const handler = (data: unknown) => {
      const raw = String(data);
      seen.push(raw);
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (msg.type === type) resolve(msg);
      else ws.once("message", handler);
    };
    ws.once("message", handler);
  });
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  const fake = new FakeRevgasClient();
  const catalog = new Catalog(fake, 2580);
  const deps: AgentDeps = {
    anthropic: {} as Pick<Anthropic, "beta">,
    orders: new OrderService(db, catalog, fake, cfg),
    catalog,
    revgas: fake,
    db,
    cfg,
  };
  const hub = new Hub();
  const conversations = new ConversationService(deps, (m) => hub.message(m), (id) => hub.changed(id), runTurn);
  hub.attach(conversations);
  app = await buildServer({ cfg, conversations, hub, db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("HTTP server", () => {
  it("reports health with writes disabled by default", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, revgasWriteEnabled: false });
    seen.push(res.body);
  });

  it("rejects an invalid conversation id", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations/not-a-uuid/messages" });
    expect(res.statusCode).toBe(400);
  });

  it("answers an invalid WebSocket message with an error and keeps the connection", async () => {
    const ws = await app.injectWS("/ws");
    const error = nextMessage(ws, "error");
    ws.send("not json");
    expect(await error).toMatchObject({ type: "error" });
    const error2 = nextMessage(ws, "error");
    ws.send(JSON.stringify({ type: "customer_message", phone: 1 }));
    expect(await error2).toMatchObject({ type: "error" });
    expect(ws.readyState).toBe(ws.OPEN);
    ws.terminate();
  });

  it("replies to a customer_message and lists the conversation", async () => {
    const ws = await app.injectWS("/ws");
    const reply = nextMessage(ws, "message");
    ws.send(JSON.stringify({ type: "customer_message", phone: "+55 86 99999-8888", text: "oi" }));
    const msg = await reply;
    expect(msg).toMatchObject({ type: "message", phone: "86999998888", author: "bot", text: "Olá! Em que posso ajudar?" });
    expect(typeof msg.createdAt).toBe("string");
    ws.terminate();

    const list = await app.inject({ method: "GET", url: "/conversations" });
    const items = list.json().items as { id: string; mode: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.mode).toBe("bot");
    seen.push(list.body);

    const history = await app.inject({ method: "GET", url: `/conversations/${items[0]!.id}/messages` });
    expect(history.json().items.map((m: { author: string }) => m.author)).toEqual(["customer", "bot"]);
    seen.push(history.body);
  });

  it("serves the metrics of today, marked as simulated while writes are off", async () => {
    const ws = await app.injectWS("/ws");
    const reply = nextMessage(ws, "message");
    ws.send(JSON.stringify({ type: "customer_message", phone: "86999998888", text: "oi" }));
    await reply;
    ws.terminate();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ simulated: true, conversations: 1, sales: { count: 0 } });
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof body.avgBotResponseMs).toBe("number");
    seen.push(res.body);
  });

  it("serves the trace of a conversation without thinking blocks", async () => {
    const [c] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
    await db.insert(llmTurns).values([
      { conversationId: c!.id, role: "assistant", content: [{ type: "thinking", thinking: "raciocínio privado", signature: "s" }, { type: "tool_use", id: "a", name: "listar_produtos", input: {} }] },
      { conversationId: c!.id, role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: JSON.stringify({ produtos: [1, 2] }) }] },
    ]);
    const res = await app.inject({ method: "GET", url: `/conversations/${c!.id}/trace` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([{ kind: "tool", name: "listar_produtos", summary: "2 produtos", isError: false, at: expect.any(String) }]);
    expect(res.body).not.toContain("raciocínio privado");
    expect((await app.inject({ method: "GET", url: "/conversations/x/trace" })).statusCode).toBe(400);
    seen.push(res.body);
  });

  it("answers 400 to an invalid metrics range", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics?from=2026-11-21&to=2026-11-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/anterior/);
  });

  it("never exposes the RevGás or Anthropic keys", () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const body of seen) {
      expect(body).not.toContain(REVGAS_KEY);
      expect(body).not.toContain(ANTHROPIC_KEY);
    }
  });
});
