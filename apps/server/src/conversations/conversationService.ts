import { asc, desc, eq, max, sql } from "drizzle-orm";
import { runAgentTurn, type AgentDeps, type ToolContext } from "../agent/agent.js";
import { conversations, messages } from "../db/schema.js";
import { normalizePhone } from "../revgas/phone.js";

export type Outgoing = { conversationId: string; phone: string; author: "bot" | "attendant" | "system"; text: string };

export type RunTurn = typeof runAgentTurn;

export const HANDOFF_TEXT = "Vou chamar um atendente para te ajudar. Só um instante!";

export type ConversationSummary = {
  id: string;
  phone: string;
  mode: "bot" | "human";
  handoffReason: string | null;
  lastMessageAt: Date;
};

/**
 * Channel-agnostic conversation flow: stores every message, routes customer text to the
 * agent (unless a human has the conversation), sends the official summary and handles handoff.
 */
export class ConversationService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: AgentDeps,
    private readonly send: (msg: Outgoing) => Promise<void>,
    private readonly onChange?: (conversationId: string) => void,
    private readonly runTurn: RunTurn = runAgentTurn,
  ) {}

  async handleCustomerMessage(rawPhone: string, text: string): Promise<void> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      console.warn("[conversas] telefone inválido; mensagem ignorada");
      return;
    }
    const conv = await this.findOrCreate(phone);
    // Timestamps use the app clock, same as presentedAt (the DB/Docker clock may drift).
    // Stored on arrival, so its timestamp reflects when the customer actually wrote it
    // (relative to when a summary was presented).
    await this.deps.db.insert(messages).values({ conversationId: conv.id, author: "customer", text, createdAt: new Date() });
    this.onChange?.(conv.id);
    await this.enqueue(conv.id, () => this.process(conv.id, phone, text));
  }

  async attendantReply(conversationId: string, text: string): Promise<void> {
    const conv = await this.get(conversationId);
    await this.deliver({ conversationId, phone: conv.phone, author: "attendant", text });
  }

  async returnToBot(conversationId: string): Promise<void> {
    await this.deps.db
      .update(conversations)
      .set({ mode: "bot", handoffReason: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    this.onChange?.(conversationId);
  }

  async list(): Promise<ConversationSummary[]> {
    const last = max(messages.createdAt);
    const rows = await this.deps.db
      .select({
        id: conversations.id,
        phone: conversations.phone,
        mode: conversations.mode,
        handoffReason: conversations.handoffReason,
        lastMessageAt: sql<Date>`coalesce(${last}, ${conversations.createdAt})`.mapWith((v) => new Date(v)),
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id)
      .orderBy(desc(sql`coalesce(${last}, ${conversations.createdAt})`));
    return rows;
  }

  async history(conversationId: string): Promise<{ author: string; text: string; createdAt: Date }[]> {
    return this.deps.db
      .select({ author: messages.author, text: messages.text, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }

  private async process(conversationId: string, phone: string, text: string): Promise<void> {
    const conv = await this.get(conversationId);
    if (conv.mode === "human") return;

    const ctx: ToolContext = { conversationId, phone, customerId: conv.revgasCustomerId ?? null, events: {} };
    let result: Awaited<ReturnType<RunTurn>>;
    try {
      result = await this.runTurn(ctx, text, this.deps);
    } catch (e) {
      console.error("[conversas] erro no agente:", e instanceof Error ? e.message : e);
      await this.handoff(conversationId, phone, "Erro interno");
      return;
    }

    if (result.replyText) await this.deliver({ conversationId, phone, author: "bot", text: result.replyText });
    const draft = result.events.draftPresentable;
    if (draft) {
      await this.deliver({ conversationId, phone, author: "bot", text: draft.summaryText });
      // Only after the summary went out does it count as presented.
      await this.deps.orders.markPresented(draft.draftId, new Date());
    }
    if (result.events.handoff) await this.handoff(conversationId, phone, result.events.handoff.reason);
  }

  private async handoff(conversationId: string, phone: string, reason: string): Promise<void> {
    await this.deps.db
      .update(conversations)
      .set({ mode: "human", handoffReason: reason, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    await this.deliver({ conversationId, phone, author: "bot", text: HANDOFF_TEXT });
    this.onChange?.(conversationId);
  }

  private async deliver(msg: Outgoing): Promise<void> {
    await this.deps.db.insert(messages).values({ conversationId: msg.conversationId, author: msg.author, text: msg.text, createdAt: new Date() });
    await this.send(msg);
    this.onChange?.(msg.conversationId);
  }

  /** Serializes work per conversation; a failing job does not block the next one. */
  private enqueue(conversationId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    this.queues.set(conversationId, tail);
    void tail.then(() => {
      if (this.queues.get(conversationId) === tail) this.queues.delete(conversationId);
    });
    return next;
  }

  private async findOrCreate(phone: string) {
    await this.deps.db.insert(conversations).values({ phone }).onConflictDoNothing({ target: conversations.phone });
    const [row] = await this.deps.db.select().from(conversations).where(eq(conversations.phone, phone));
    return row!;
  }

  private async get(conversationId: string) {
    const [row] = await this.deps.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!row) throw new Error("Conversa não encontrada");
    return row;
  }
}
