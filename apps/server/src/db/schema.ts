import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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
  revgasCustomerId: bigint("revgas_customer_id", { mode: "number" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
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
  hasEmptyCylinder: boolean("has_empty_cylinder"),
  revgasCustomerId: bigint("revgas_customer_id", { mode: "number" }),
  lastSaleId: bigint("last_sale_id", { mode: "number" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    author: text("author", { enum: ["customer", "bot", "attendant", "system"] }).notNull(),
    text: text("text").notNull(),
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
