import type Anthropic from "@anthropic-ai/sdk";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmTurns } from "../db/schema.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { runTool, toolDefinitions, type AgentDeps, type ToolContext } from "./tools.js";

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
  if (closing) await db.insert(llmTurns).values({ conversationId, role: "user", content: closing });
  await db.insert(llmTurns).values({ conversationId, role: "user", content: [{ type: "text", text }] });
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
    await deps.db.insert(llmTurns).values({ conversationId: ctx.conversationId, role, content });
    messages.push({ role, content } as MessageParam);
  };

  const closing = pendingToolResults(messages.at(-1));
  if (closing) await append("user", closing);

  await append("user", customerText);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await deps.anthropic.beta.messages.create({
      model: deps.cfg.anthropicModel,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages: [...messages],
      output_config: { effort: deps.cfg.anthropicEffort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

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
