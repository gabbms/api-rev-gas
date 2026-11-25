import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWahaWebhookServer, type WahaWebhookServer } from "../../../src/channels/waha/server.js";
import type { InboundMessage } from "../../../src/channels/waha/webhook.js";
import { loadConfig } from "../../../src/config.js";
import type { Db } from "../../../src/db/client.js";
import { inboundEvents } from "../../../src/db/schema.js";
import { resetTables, setupTestDb } from "../../helpers/testDb.js";

const SECRET = "webhook-secret-should-never-leak";
const KEY = "waha-key-should-never-leak";
const base = { DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a", WHATSAPP_PROVIDER: "waha", WAHA_API_KEY: KEY, WAHA_WEBHOOK_SECRET: SECRET };

let db: Db;
let close: () => Promise<void>;
let app: WahaWebhookServer;
let received: InboundMessage[];
let resolveLid: ReturnType<typeof vi.fn<(lid: string) => Promise<string | undefined>>>;

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});

function build(env: Record<string, string> = {}) {
  app = buildWahaWebhookServer({
    cfg: loadConfig({ ...base, ...env }),
    db,
    resolveLid,
    onInbound: async (m) => {
      received.push(m);
    },
  });
  return app;
}

beforeEach(async () => {
  await resetTables(db);
  received = [];
  resolveLid = vi.fn(async () => undefined);
  build();
});
afterEach(async () => {
  await app.close();
});

const event = (payload: Record<string, unknown> = {}) => ({
  event: "message",
  session: "default",
  payload: { id: "false_5586999998888@c.us_AAA", timestamp: 1793404800, from: "5586999998888@c.us", fromMe: false, body: "oi", hasMedia: false, ...payload },
});

const post = (body: unknown, secret: string | null = SECRET) =>
  app.inject({ method: "POST", url: "/webhooks/waha", payload: body as object, headers: secret === null ? {} : { "x-revgas-secret": secret } });

describe("WAHA webhook server", () => {
  it("Review Focus 2: without the secret, or with a wrong one, answers 401 and processes nothing", async () => {
    expect((await post(event(), null)).statusCode).toBe(401);
    expect((await post(event(), "wrong")).statusCode).toBe(401);
    await app.idle();
    expect(received).toEqual([]);
    expect(await db.select().from(inboundEvents)).toEqual([]);
  });

  it("with the secret, answers 200 and hands the message over once", async () => {
    const res = await post(event());
    expect(res.statusCode).toBe(200);
    await app.idle();
    expect(received).toEqual([expect.objectContaining({ id: "false_5586999998888@c.us_AAA", from: "5586999998888", text: "oi", kind: "text" })]);
  });

  it("stamps each message with the time its POST arrived, even while the sender's previous one is still being handled", async () => {
    await app.close();
    let release!: () => void;
    const firstDone = new Promise<void>((r) => (release = r));
    const stamps: { id: string; receivedAt: Date }[] = [];
    app = buildWahaWebhookServer({
      cfg: loadConfig(base),
      db,
      resolveLid,
      onInbound: async (m, receivedAt) => {
        stamps.push({ id: m.id, receivedAt });
        if (m.id === "first") await firstDone;
      },
    });
    await post(event({ id: "first" }));
    await vi.waitFor(() => expect(stamps).toHaveLength(1));
    await post(event({ id: "second", body: "sim" }));
    await new Promise((r) => setTimeout(r, 10));
    const releasedAt = new Date();
    release();
    await app.idle();
    expect(stamps.map((s) => s.id)).toEqual(["first", "second"]);
    expect(stamps[1]!.receivedAt.getTime()).toBeLessThan(releasedAt.getTime());
  });

  it("an @lid message keeps the time its POST arrived", async () => {
    await app.close();
    const stamps: Date[] = [];
    resolveLid.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "5586911112222";
    });
    app = buildWahaWebhookServer({ cfg: loadConfig(base), db, resolveLid, onInbound: async (_m, at) => void stamps.push(at) });
    const before = Date.now();
    await post(event({ from: "123@lid" }));
    const after = Date.now();
    await app.idle();
    expect(stamps[0]!.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamps[0]!.getTime()).toBeLessThanOrEqual(after);
  });

  it("Review Focus 1: the same event twice runs once", async () => {
    await post(event());
    await post(event());
    await app.idle();
    expect(received).toHaveLength(1);
    expect(await db.select().from(inboundEvents)).toHaveLength(1);
  });

  it("Review Focus 1: two copies arriving at the same time still run once", async () => {
    await Promise.all([post(event()), post(event())]);
    await app.idle();
    expect(received).toHaveLength(1);
  });

  it("Review Focus 3: an @lid contact with a known phone goes on, with the resolved phone", async () => {
    resolveLid.mockResolvedValue("5586911112222");
    await post(event({ from: "123@lid" }));
    await app.idle();
    expect(resolveLid).toHaveBeenCalledWith("123@lid");
    expect(received).toEqual([expect.objectContaining({ from: "5586911112222", text: "oi" })]);
  });

  it("Review Focus 3: an @lid contact without a phone is dropped, logging no content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post(event({ from: "123@lid", body: "meu endereço secreto" }));
    await app.idle();
    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[whatsapp] contato @lid sem telefone; mensagem ignorada");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secreto");
    warn.mockRestore();
  });

  it("ignores numbers outside WHATSAPP_ALLOWED_NUMBERS", async () => {
    await app.close();
    build({ WHATSAPP_ALLOWED_NUMBERS: "86911112222" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await post(event());
    await post(event({ id: "other", from: "5586911112222@c.us" }));
    await app.idle();
    expect(received.map((m) => m.from)).toEqual(["5586911112222"]);
    info.mockRestore();
  });

  it("matches the allowed list with or without the ninth digit", async () => {
    await app.close();
    build({ WHATSAPP_ALLOWED_NUMBERS: "86994264580, 8633334444" });
    await post(event({ id: "a", from: "558694264580@c.us" }));
    await post(event({ id: "b", from: "5586933334444@c.us" }));
    await app.idle();
    expect(received.map((m) => m.from)).toEqual(["558694264580"]);
  });

  it("ignores our own messages and groups, still answering 200", async () => {
    expect((await post(event({ fromMe: true }))).statusCode).toBe(200);
    expect((await post(event({ id: "g", from: "1203@g.us" }))).statusCode).toBe(200);
    await app.idle();
    expect(received).toEqual([]);
  });

  it("keeps going when the handler fails, logging no content", async () => {
    await app.close();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    app = buildWahaWebhookServer({ cfg: loadConfig(base), db, resolveLid, onInbound: async () => { throw new Error("boom"); } });
    expect((await post(event({ body: "conteúdo privado" }))).statusCode).toBe(200);
    await app.idle();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("conteúdo privado");
    error.mockRestore();
  });

  it("has only POST /webhooks/waha: the panel routes answer 404", async () => {
    for (const [method, url] of [["GET", "/conversations"], ["GET", "/ws"], ["GET", "/health"], ["GET", "/metrics"], ["GET", "/webhooks/waha"]] as const) {
      const res = await app.inject({ method, url, headers: { "x-revgas-secret": SECRET } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("never puts the secrets in a response", async () => {
    for (const res of [await post(event(), null), await post(event()), await post("{lixo", SECRET), await app.inject({ method: "GET", url: "/x" })]) {
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(KEY);
      expect(JSON.stringify(res.headers)).not.toContain(SECRET);
    }
  });
});
