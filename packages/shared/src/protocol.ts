import { z } from "zod";

// Client → server
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("customer_message"), phone: z.string().min(1).max(40), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("attendant_reply"), conversationId: z.uuid(), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("return_to_bot"), conversationId: z.uuid() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const authorSchema = z.enum(["customer", "bot", "attendant", "system"]);
export type Author = z.infer<typeof authorSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  phone: z.string(),
  mode: z.enum(["bot", "human"]),
  handoffReason: z.string().nullable(),
  lastMessageAt: z.string(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const historyItemSchema = z.object({ author: authorSchema, text: z.string(), createdAt: z.string() });
export type HistoryItem = z.infer<typeof historyItemSchema>;

// Server → client
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    conversationId: z.string(),
    phone: z.string(),
    author: authorSchema,
    text: z.string(),
    createdAt: z.string(),
  }),
  z.object({ type: z.literal("conversations"), items: z.array(conversationSummarySchema) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// GET /metrics
export const metricsSchema = z.object({
  from: z.string(),
  to: z.string(),
  simulated: z.boolean(),
  conversations: z.number(),
  botResolved: z.number(),
  automationRate: z.number(),
  sales: z.object({ count: z.number(), totalCents: z.number(), averageTicketCents: z.number() }),
  handoffs: z.object({ total: z.number(), byReason: z.array(z.object({ reason: z.string(), count: z.number() })) }),
  avgBotResponseMs: z.number().nullable(),
  avgTimeToOrderMs: z.number().nullable(),
});
export type Metrics = z.infer<typeof metricsSchema>;
