import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { inboundEvents } from "../../db/schema.js";
import { normalizePhone } from "../../revgas/phone.js";
import { verifyWahaSecret } from "./client.js";
import { parseWahaWebhook, type InboundMessage } from "./webhook.js";

export const WEBHOOK_PATH = "/webhooks/waha";

/**
 * A mobile number with and without the ninth digit (WhatsApp keeps some old numbers without it).
 * Only for mobiles: the 8-digit part starts with 6–9.
 */
export function ninthDigitVariants(phone: string): string[] {
  if (phone.length === 10 && /[6-9]/.test(phone[2]!)) return [phone, `${phone.slice(0, 2)}9${phone.slice(2)}`];
  if (phone.length === 11 && phone[2] === "9" && /[6-9]/.test(phone[3]!)) return [phone, `${phone.slice(0, 2)}${phone.slice(3)}`];
  return [phone];
}

export type WahaWebhookServer = FastifyInstance & {
  /** Resolves once every message received so far has been handled (for tests and shutdown). */
  idle(): Promise<void>;
};

/**
 * The only thing exposed to WAHA: its own Fastify instance, on its own port, with just
 * POST /webhooks/waha. Everything else (panel, WebSocket) stays on the main server.
 */
export function buildWahaWebhookServer(deps: {
  cfg: AppConfig;
  db: Db;
  resolveLid: (lid: string) => Promise<string | undefined>;
  /**
   * `receivedAt`: when the POST arrived (app clock). The sender's queue may hold a message while the
   * previous one is answered; storing it with this time keeps a "sim" sent mid-turn from counting as
   * a reply to a summary presented later.
   */
  onInbound: (m: InboundMessage, receivedAt: Date) => Promise<void>;
}): WahaWebhookServer {
  const { cfg, db } = deps;
  const secret = cfg.wahaWebhookSecret;
  if (!secret) throw new Error("WAHA_WEBHOOK_SECRET é obrigatória para o webhook do WhatsApp");

  // No request logging: headers carry the secret and bodies carry customer messages.
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 }) as unknown as WahaWebhookServer;
  const pending = new Set<Promise<void>>();
  // One sender's messages are handled in arrival order; different senders do not wait for each other.
  const perSender = new Map<string, Promise<void>>();

  async function take(m: InboundMessage, receivedAt: Date): Promise<void> {
    const fresh = await db.insert(inboundEvents).values({ id: m.id }).onConflictDoNothing().returning({ id: inboundEvents.id });
    if (fresh.length === 0) return; // repeated webhook
    const allowed = cfg.whatsappAllowedNumbers;
    const phone = normalizePhone(m.from);
    if (allowed && !(phone && ninthDigitVariants(phone).some((p) => allowed.includes(p)))) {
      console.info("[whatsapp] número fora de WHATSAPP_ALLOWED_NUMBERS; mensagem ignorada");
      return;
    }
    await deps.onInbound(m, receivedAt);
  }

  function schedule(key: string, job: () => Promise<void>): void {
    const run = (perSender.get(key) ?? Promise.resolve()).then(job).catch((e: unknown) => {
      console.error("[whatsapp] falha ao processar mensagem recebida:", e instanceof Error ? e.name : "erro");
    });
    perSender.set(key, run);
    pending.add(run);
    void run.finally(() => {
      pending.delete(run);
      if (perSender.get(key) === run) perSender.delete(key);
    });
  }

  // The secret is checked in onRequest, before the body is read: without it nothing is parsed.
  const checkSecret = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers["x-revgas-secret"];
    if (!verifyWahaSecret(typeof header === "string" ? header : undefined, secret)) return reply.code(401).send();
  };

  app.post(WEBHOOK_PATH, { onRequest: checkSecret }, async (req, reply) => {
    const receivedAt = new Date();
    const { messages, lids } = parseWahaWebhook(req.body);
    // Answer 200 right away; the work goes on in the background.
    for (const m of messages) schedule(m.from, () => take(m, receivedAt));
    for (const { lid, message } of lids) {
      schedule(lid, async () => {
        const from = await deps.resolveLid(lid);
        if (from === undefined) {
          console.warn("[whatsapp] contato @lid sem telefone; mensagem ignorada");
          return;
        }
        await take({ ...message, from }, receivedAt);
      });
    }
    return reply.code(200).send();
  });

  app.idle = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  app.addHook("onClose", async () => app.idle());
  return app;
}
