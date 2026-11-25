import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import { appendContextTurn, runAgentTurn, type AgentDeps, type ToolContext } from "../agent/agent.js";
import { conversations, handoffs, messages } from "../db/schema.js";
import { normalizePhone } from "../revgas/phone.js";

export type Outgoing = {
  conversationId: string;
  phone: string;
  author: "bot" | "attendant" | "system";
  text: string;
  /** The stored message, so the channel can record whether it was delivered. */
  messageId: string;
  /** The official order summary (WhatsApp sends it with the Confirmar / Mudar algo list). */
  kind?: "summary";
};

export type Channel = "simulated" | "whatsapp";

export type Inbound = {
  channel: Channel;
  /** WhatsApp: the sender's digits with 55 (where replies go). Null for the simulated chat. */
  address: string | null;
  rawPhone: string;
  text: string;
  /**
   * text: goes to the AI. audio: `text` is the transcription (stored with 🎤, sent to the AI with a
   * prefix). unsupported / audio_failed / audio_too_long: fixed reply, the AI is not called.
   */
  kind?: "text" | "unsupported" | "audio" | "audio_failed" | "audio_too_long";
  /** When the message reached us (WhatsApp: the webhook POST). Defaults to now. */
  receivedAt?: Date;
};

export type RunTurn = typeof runAgentTurn;

export const HANDOFF_TEXT = "Vou chamar um atendente para te ajudar. Só um instante!";
export const EMPTY_TURN_TEXT = "Desculpe, não entendi. Pode repetir?";
export const UNSUPPORTED_TEXT = "Por enquanto eu entendo só mensagens de texto. Pode escrever o seu pedido?";
export const WHATSAPP_ONLY_TEXT = "Esta conversa é do WhatsApp; responda pelo painel";
export const AUDIO_FAILED_TEXT = "Não consegui entender o seu áudio. Pode escrever para mim?";
export const AUDIO_TOO_LONG_TEXT = "Esse áudio ficou longo demais para mim. Pode mandar um mais curto ou escrever?";
/** What the AI sees before a transcribed voice note (the prompt explains it). */
export const AUDIO_PREFIX = "[Áudio do cliente, transcrito automaticamente]";

/** Messages answered with a fixed text, without the AI (none while a human attends). */
const FIXED_REPLY: Partial<Record<NonNullable<Inbound["kind"]>, string>> = {
  unsupported: UNSUPPORTED_TEXT,
  audio_failed: AUDIO_FAILED_TEXT,
  audio_too_long: AUDIO_TOO_LONG_TEXT,
};

/** A simulated-chat message aimed at a real WhatsApp customer's conversation. */
export class ChannelMismatchError extends Error {
  constructor() {
    super(WHATSAPP_ONLY_TEXT);
    this.name = "ChannelMismatchError";
  }
}

export type ConversationSummary = {
  id: string;
  phone: string;
  mode: "bot" | "human";
  channel: Channel;
  handoffReason: string | null;
  lastMessageAt: Date;
};

/**
 * Channel-agnostic conversation flow: stores every message, routes customer text to the
 * agent (unless a human has the conversation), sends the official summary and handles handoff.
 */
export class ConversationService {
  private readonly queues = new Map<string, Promise<void>>();
  /** Consecutive AI turns with nothing to send, per conversation. */
  private readonly emptyTurns = new Map<string, number>();

  constructor(
    private readonly deps: AgentDeps,
    private readonly send: (msg: Outgoing) => Promise<void>,
    private readonly onChange?: (conversationId: string) => void,
    private readonly runTurn: RunTurn = runAgentTurn,
  ) {}

  /** The simulated chat. */
  async handleCustomerMessage(rawPhone: string, text: string): Promise<void> {
    await this.handleInbound({ channel: "simulated", address: null, rawPhone, text });
  }

  async handleInbound(m: Inbound): Promise<void> {
    const phone = normalizePhone(m.rawPhone);
    if (!phone) {
      console.warn("[conversas] telefone inválido; mensagem ignorada");
      return;
    }
    const conv = await this.findOrCreate(phone, m);
    // Typing in the simulated chat must never reach a real WhatsApp customer.
    if (m.channel === "simulated" && conv.channel === "whatsapp") throw new ChannelMismatchError();
    // Timestamps use the app clock, same as presentedAt (the DB/Docker clock may drift).
    // Stored with the arrival time, so it reflects when the customer actually wrote it relative to
    // when a summary was presented, even if it waited in the sender's queue.
    const isAudio = m.kind === "audio";
    await this.deps.db
      .insert(messages)
      .values({ conversationId: conv.id, author: "customer", text: isAudio ? `🎤 ${m.text}` : m.text, createdAt: m.receivedAt ?? new Date() });
    this.onChange?.(conv.id);
    const fixed = m.kind ? FIXED_REPLY[m.kind] : undefined;
    if (fixed) {
      await this.enqueue(conv.id, async () => {
        if ((await this.get(conv.id)).mode === "human") return;
        await this.deliver({ conversationId: conv.id, phone, author: "bot", text: fixed });
      });
      return;
    }
    // A transcribed voice note goes the same way as text (prices, summary and confirmation stay in code).
    const forAi = isAudio ? `${AUDIO_PREFIX} ${m.text}` : m.text;
    await this.enqueue(conv.id, () => this.process(conv.id, phone, forAi));
  }

  async attendantReply(conversationId: string, text: string): Promise<void> {
    const conv = await this.get(conversationId);
    await this.deliver({ conversationId, phone: conv.phone, author: "attendant", text });
  }

  async returnToBot(conversationId: string): Promise<void> {
    await this.enqueue(conversationId, async () => {
      const conv = await this.get(conversationId);
      if (conv.mode === "human") {
        // The AI never saw the human period: hand it a summary (append-only).
        const since = conv.handoffAt ?? conv.updatedAt;
        const rows = await this.deps.db
          .select({ author: messages.author, text: messages.text })
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since)))
          .orderBy(asc(messages.createdAt), asc(messages.id));
        const lines = rows
          .filter((m) => m.author === "customer" || m.author === "attendant")
          .map((m) => `${m.author === "customer" ? "Cliente" : "Atendente"}: ${m.text}`);
        const text = [
          `[Atendimento humano] A conversa ficou com um atendente${conv.handoffReason ? ` (motivo: ${conv.handoffReason})` : ""}.`,
          ...(lines.length ? lines : ["Nenhuma mensagem trocada nesse período."]),
          "A conversa voltou para você. Continue a partir daqui.",
        ].join("\n");
        await appendContextTurn(this.deps.db, conversationId, text);
      }
      await this.deps.db
        .update(conversations)
        .set({ mode: "bot", handoffReason: null, handoffAt: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
    this.onChange?.(conversationId);
  }

  async list(): Promise<ConversationSummary[]> {
    const last = max(messages.createdAt);
    const rows = await this.deps.db
      .select({
        id: conversations.id,
        phone: conversations.phone,
        mode: conversations.mode,
        channel: conversations.channel,
        handoffReason: conversations.handoffReason,
        lastMessageAt: sql<Date>`coalesce(${last}, ${conversations.createdAt})`.mapWith((v) => new Date(v)),
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id)
      .orderBy(desc(sql`coalesce(${last}, ${conversations.createdAt})`));
    return rows;
  }

  async history(
    conversationId: string,
  ): Promise<{ author: string; text: string; createdAt: Date; deliveryStatus: "sent" | "failed" | null }[]> {
    return this.deps.db
      .select({ author: messages.author, text: messages.text, createdAt: messages.createdAt, deliveryStatus: messages.deliveryStatus })
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

    const draft = result.events.draftPresentable;
    if (!result.replyText && !draft && !result.events.handoff) {
      // Nothing to say: ask once, then hand off on the second empty turn in a row.
      const empties = (this.emptyTurns.get(conversationId) ?? 0) + 1;
      if (empties >= 2) {
        this.emptyTurns.delete(conversationId);
        await this.handoff(conversationId, phone, "IA sem resposta");
      } else {
        this.emptyTurns.set(conversationId, empties);
        await this.deliver({ conversationId, phone, author: "bot", text: EMPTY_TURN_TEXT });
      }
      return;
    }
    this.emptyTurns.delete(conversationId);

    if (result.replyText) await this.deliver({ conversationId, phone, author: "bot", text: result.replyText });
    if (draft) {
      await this.deliver({ conversationId, phone, author: "bot", text: draft.summaryText, kind: "summary" });
      // Only after the summary went out does it count as presented.
      await this.deps.orders.markPresented(draft.draftId, new Date());
    }
    if (result.events.handoff) await this.handoff(conversationId, phone, result.events.handoff.reason);
  }

  private async handoff(conversationId: string, phone: string, reason: string): Promise<void> {
    await this.deps.db
      .update(conversations)
      .set({ mode: "human", handoffReason: reason, handoffAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    await this.deps.db.insert(handoffs).values({ conversationId, reason, createdAt: new Date() });
    // A "sim" sent while a human attends must not confirm the summary shown before.
    await this.deps.orders.clearPresentation(conversationId);
    await this.deliver({ conversationId, phone, author: "bot", text: HANDOFF_TEXT });
    this.onChange?.(conversationId);
  }

  private async deliver(msg: Omit<Outgoing, "messageId">): Promise<void> {
    const [row] = await this.deps.db
      .insert(messages)
      .values({ conversationId: msg.conversationId, author: msg.author, text: msg.text, createdAt: new Date() })
      .returning({ id: messages.id });
    await this.send({ ...msg, messageId: row!.id });
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

  private async findOrCreate(phone: string, m: Inbound) {
    const address = m.channel === "whatsapp" && m.address ? m.address.replace(/\D/g, "") : null;
    await this.deps.db
      .insert(conversations)
      .values(address ? { phone, channel: "whatsapp", channelAddress: address } : { phone })
      .onConflictDoNothing({ target: conversations.phone });
    const [row] = await this.deps.db.select().from(conversations).where(eq(conversations.phone, phone));
    // A WhatsApp message makes (or keeps) the conversation a WhatsApp one, replying to the latest address.
    if (address && (row!.channel !== "whatsapp" || row!.channelAddress !== address)) {
      const [updated] = await this.deps.db
        .update(conversations)
        .set({ channel: "whatsapp", channelAddress: address, updatedAt: new Date() })
        .where(eq(conversations.id, row!.id))
        .returning();
      return updated!;
    }
    return row!;
  }

  private async get(conversationId: string) {
    const [row] = await this.deps.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!row) throw new Error("Conversa não encontrada");
    return row;
  }
}
