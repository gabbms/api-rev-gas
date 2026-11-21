import websocket from "@fastify/websocket";
import { clientMessageSchema, type ConversationSummary, type ServerMessage } from "@revgas/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ConversationService, Outgoing } from "../conversations/conversationService.js";
import type { Db } from "../db/client.js";
import { computeMetrics, parseRange } from "../metrics/metrics.js";
import { buildTrace } from "../conversations/trace.js";

type Socket = { send(data: string): void; readyState: number; OPEN: number };

const toSummary = (c: Awaited<ReturnType<ConversationService["list"]>>[number]): ConversationSummary => ({
  ...c,
  lastMessageAt: c.lastMessageAt.toISOString(),
});

/** Fan-out to every connected page (the simulated chat shows customer and attendant views). */
export class Hub {
  private readonly sockets = new Set<Socket>();
  private conversations?: ConversationService;
  private pendingList?: ReturnType<typeof setTimeout>;

  attach(conversations: ConversationService): void {
    this.conversations = conversations;
  }

  add(socket: Socket): void {
    this.sockets.add(socket);
  }

  remove(socket: Socket): void {
    this.sockets.delete(socket);
  }

  async message(m: Outgoing): Promise<void> {
    this.broadcast({ type: "message", ...m, createdAt: new Date().toISOString() });
  }

  /** Coalesces bursts of changes into one conversation-list broadcast. */
  changed(_conversationId: string): void {
    if (this.pendingList) return;
    this.pendingList = setTimeout(() => {
      this.pendingList = undefined;
      void this.sendList();
    }, 50);
  }

  async sendList(target?: Socket): Promise<void> {
    if (!this.conversations) return;
    try {
      const items = (await this.conversations.list()).map(toSummary);
      const msg: ServerMessage = { type: "conversations", items };
      if (target) send(target, msg);
      else this.broadcast(msg);
    } catch (e) {
      console.error("[ws] falha ao listar conversas:", e instanceof Error ? e.message : e);
    }
  }

  close(): void {
    if (this.pendingList) clearTimeout(this.pendingList);
    this.pendingList = undefined;
  }

  private broadcast(msg: ServerMessage): void {
    for (const s of this.sockets) send(s, msg);
  }
}

function send(socket: Socket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

const idParams = z.object({ id: z.uuid() });
const metricsQuery = z.object({ from: z.string().optional(), to: z.string().optional() });

export async function buildServer(deps: {
  cfg: AppConfig;
  conversations: ConversationService;
  hub: Hub;
  db: Db;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const { cfg, conversations, hub, db } = deps;
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(websocket);
  app.addHook("onClose", async () => hub.close());

  app.get("/health", async () => ({ ok: true, revgasWriteEnabled: cfg.revgasWriteEnabled }));

  app.get("/conversations", async () => ({ items: (await conversations.list()).map(toSummary) }));

  app.get("/metrics", async (req, reply) => {
    const q = metricsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Parâmetros inválidos" });
    let range;
    try {
      range = parseRange(q.data.from, q.data.to);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Período inválido" });
    }
    return computeMetrics(db, range, { simulated: !cfg.revgasWriteEnabled });
  });

  app.get("/conversations/:id/messages", async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "id inválido" });
    const items = await conversations.history(params.data.id);
    return { items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) };
  });

  // What the AI did (tools and short results), for the attendant. No thinking, no raw content.
  app.get("/conversations/:id/trace", async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "id inválido" });
    const items = await buildTrace(db, params.data.id);
    return { items: items.map((i) => ({ ...i, at: i.at.toISOString() })) };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);
    void hub.sendList(socket);
    socket.on("close", () => hub.remove(socket));
    socket.on("message", async (data: Buffer) => {
      let parsed;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(String(data)));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        send(socket, { type: "error", message: "Mensagem inválida" });
        return;
      }
      const msg = parsed.data;
      try {
        if (msg.type === "customer_message") await conversations.handleCustomerMessage(msg.phone, msg.text);
        else if (msg.type === "attendant_reply") await conversations.attendantReply(msg.conversationId, msg.text);
        else await conversations.returnToBot(msg.conversationId);
      } catch (e) {
        console.error("[ws] erro ao processar mensagem:", e instanceof Error ? e.message : e);
        send(socket, { type: "error", message: "Não foi possível processar a mensagem" });
      }
    });
  });

  return app;
}
