import type Anthropic from "@anthropic-ai/sdk";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmTurns } from "../db/schema.js";
import { systemPromptFor } from "./systemPrompt.js";
import { runTool, toolDefinitionsFor, type AgentDeps, type ToolContext } from "./tools.js";

export type { AgentDeps, ToolContext } from "./tools.js";

const MAX_ITERATIONS = 8;

type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * A crash between storing an assistant tool_use and its tool_result leaves the history
 * unreplayable. Returns the error results that close it (to be appended, never edited in).
 */
function pendingToolResults(last: { role: string; content?: unknown } | undefined) {
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return null;
  const pending = (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use" && b.id);
  if (pending.length === 0) return null;
  console.warn(`[agente] ${pending.length} ferramenta(s) sem resultado no histórico; registrando "Execução interrompida"`);
  return pending.map((b) => ({ type: "tool_result", tool_use_id: b.id!, content: "Execução interrompida", is_error: true }));
}

/** Logs which stored thinking blocks the API dropped (or accepted despite a mismatch). Never content. */
function logInputTransformations(
  conversationId: string,
  transformations: Anthropic.Beta.BetaInputTransformation[] | null | undefined,
): void {
  if (!transformations?.length) return;
  const known = { thinking_dropped: "descartado(s)", thinking_mismatch_allowed: "aceito(s) com divergência" } as const;
  for (const [type, label] of Object.entries(known)) {
    const reasons = transformations.filter((t) => t.type === type).map((t) => t.reason);
    if (reasons.length === 0) continue;
    console.warn(
      `[agente] conversa ${conversationId}: ${reasons.length} bloco(s) de raciocínio ${label} pela API (${reasons.join(", ")})`,
    );
  }
}

/**
 * Appends a user turn with operator-side context (e.g. what happened with a human attendant),
 * closing any pending tool_use first. Append-only.
 */
export async function appendContextTurn(db: Db, conversationId: string, text: string): Promise<void> {
  const [last] = await db
    .select({ role: llmTurns.role, content: llmTurns.content })
    .from(llmTurns)
    .where(eq(llmTurns.conversationId, conversationId))
    .orderBy(desc(llmTurns.id))
    .limit(1);
  const closing = pendingToolResults(last);
  if (closing) await db.insert(llmTurns).values({ conversationId, role: "user", content: closing, createdAt: new Date() });
  await db.insert(llmTurns).values({ conversationId, role: "user", content: [{ type: "text", text }], createdAt: new Date() });
}

/**
 * One customer message → model loop with tools. History in `llm_turns` is append-only:
 * every response's full `content` (thinking blocks included) is stored and replayed verbatim.
 */
export async function runAgentTurn(
  ctx: ToolContext,
  customerText: string,
  deps: AgentDeps,
): Promise<{ replyText: string | null; events: ToolContext["events"] }> {
  const history = await deps.db
    .select({ role: llmTurns.role, content: llmTurns.content })
    .from(llmTurns)
    .where(eq(llmTurns.conversationId, ctx.conversationId))
    .orderBy(asc(llmTurns.id));
  const messages = history.map((t) => ({ role: t.role, content: t.content }) as MessageParam);

  const append = async (role: "user" | "assistant", content: unknown) => {
    await deps.db.insert(llmTurns).values({ conversationId: ctx.conversationId, role, content, createdAt: new Date() }); // app clock, same as messages
    messages.push({ role, content } as MessageParam);
  };

  const closing = pendingToolResults(messages.at(-1));
  if (closing) await append("user", closing);

  await append("user", customerText);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await deps.anthropic.beta.messages.create({
      model: deps.cfg.anthropicModel,
      max_tokens: 16000,
      system: systemPromptFor(deps.cfg),
      tools: toolDefinitionsFor(deps.cfg),
      messages: [...messages],
      output_config: { effort: deps.cfg.anthropicEffort },
      // Stored thinking is bound to the exact prompt and tools it was made with; after a tool or
      // prompt change the API drops those blocks instead of rejecting the request. Per request.
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
      fallbacks: "default",
    });
    logInputTransformations(ctx.conversationId, response.input_transformations);

    // Checked before reading content. A refused turn is not stored; the next customer
    // message simply follows the last stored user turn.
    if (response.stop_reason === "refusal") {
      ctx.events.handoff ??= { reason: "IA recusou" };
      return { replyText: null, events: ctx.events };
    }

    await append("assistant", response.content);

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        // Every tool_use must get a tool_result, or the stored history becomes unreplayable.
        const r = await runTool(use.name, use.input, ctx, deps).catch((e: unknown) => {
          console.error(`[agent] ferramenta ${use.name} falhou:`, e instanceof Error ? e.message : e);
          ctx.events.handoff ??= { reason: "Erro interno" };
          return { content: "Erro interno ao executar a ferramenta. Um atendente vai assumir.", isError: true };
        });
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      await append("user", results);
      continue;
    }
    if (response.stop_reason === "pause_turn") continue;

    const replyText = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { replyText: replyText || null, events: ctx.events };
  }

  ctx.events.handoff ??= { reason: "Limite de passos da IA" };
  return { replyText: null, events: ctx.events };
}
