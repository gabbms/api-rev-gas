import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  mode: text("mode", { enum: ["bot", "human"] }).notNull().default("bot"),
  handoffReason: text("handoff_reason"),
  /** When the conversation went to a human; the summary for the AI starts here. */
  handoffAt: timestamp("handoff_at", { withTimezone: true }),
  revgasCustomerId: bigint("revgas_customer_id", { mode: "number" }),
  /** Where the conversation came from; replies go back through the same channel. */
  channel: text("channel", { enum: ["simulated", "whatsapp"] }).notNull().default("simulated"),
  /** WhatsApp: the sender's digits with 55, as WAHA sent them. Null for the simulated chat. */
  channelAddress: text("channel_address"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Ids of inbound WhatsApp messages already taken, so a repeated webhook is processed once. */
export const inboundEvents = pgTable("inbound_events", {
  id: text("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * C1: the token cannot read RevGás customers (403), so we remember who bought from which phone.
 * Written only after a sale is created; address columns stay null until then.
 */
export const customerProfiles = pgTable("customer_profiles", {
  phone: text("phone").primaryKey(),
  name: text("name"),
  location: text("location"),
  number: text("number"),
  neighborhood: text("neighborhood"),
  city: text("city"),
  state: text("state"),
  complement: text("complement"),
  landmark: text("landmark"),
  /** Empty cylinders the customer swapped on the last sale. */
  emptyCylinders: integer("empty_cylinders"),
  revgasCustomerId: bigint("revgas_customer_id", { mode: "number" }),
  /** RevGás customer category (tag_id), for TAG price deals. */
  revgasTagId: bigint("revgas_tag_id", { mode: "number" }),
  lastSaleId: bigint("last_sale_id", { mode: "number" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Sales simulated while REVGAS_WRITE_ENABLED=false. Survive restarts so "cadê meu gás?" still
 * works; the identity never reuses an id. Starts far above real RevGás ids.
 */
export const simulatedSales = pgTable("simulated_sales", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ startWith: 900_000_001 }),
  payload: jsonb("payload").notNull(),
  totalCents: integer("total_cents").notNull(),
  status: text("status").notNull().default("OPEN"),
  createdAt: createdAt(),
});

/** Every handoff to a human, with its reason (the conversation keeps only the latest). For metrics. */
export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("handoffs_created_idx").on(t.createdAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    author: text("author", { enum: ["customer", "bot", "attendant", "system"] }).notNull(),
    text: text("text").notNull(),
    /** WhatsApp replies only: whether WAHA accepted it. Null elsewhere. */
    deliveryStatus: text("delivery_status", { enum: ["sent", "failed"] }),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_created_idx").on(t.conversationId, t.createdAt)],
);

/** Append-only: content blocks exactly as sent to / received from the model. */
export const llmTurns = pgTable(
  "llm_turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: jsonb("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_turns_conversation_idx").on(t.conversationId, t.id)],
);

export const orderDrafts = pgTable(
  "order_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    status: text("status", { enum: ["open", "sending", "created", "failed", "uncertain"] }).notNull(),
    payload: jsonb("payload").notNull(),
    totalCents: integer("total_cents").notNull(),
    summaryText: text("summary_text"),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    revgasSaleId: bigint("revgas_sale_id", { mode: "number" }),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("order_drafts_one_active_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.status} in ('open', 'sending')`),
    index("order_drafts_conversation_created_idx").on(t.conversationId, t.createdAt),
  ],
);
