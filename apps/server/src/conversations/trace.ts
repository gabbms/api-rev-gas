import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmTurns, messages } from "../db/schema.js";

export type TraceItem =
  | { kind: "message"; author: string; text: string; at: Date }
  | { kind: "tool"; name: string; summary: string; isError: boolean; at: Date };

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

const MAX = 120;
const short = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : "")).join(" ");
  return "";
}

function parse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One short, derived line per tool call. Never the raw result (it can hold addresses and more). */
function summarize(name: string, input: unknown, content: string, isError: boolean): string {
  if (content === "Execução interrompida") return "execução interrompida";
  if (isError) {
    // Our own error texts: drop the generic prefix, keep the reason.
    return short(content.replace(/^Pedido não pôde ser montado: /, "").replace(/^Entrada inválida: /, "entrada inválida: "));
  }
  switch (name) {
    case "buscar_cliente": {
      const v = parse(content);
      if (v?.cliente === "conhecido") return `cliente conhecido${typeof v.nome === "string" ? `: ${v.nome}` : ""}`;
      if (v?.cliente === "novo") return "cliente novo";
      return "concluída";
    }
    case "listar_produtos": {
      const v = parse(content);
      return Array.isArray(v?.produtos) ? `${v.produtos.length} produtos` : "concluída";
    }
    case "montar_pedido": {
      const total = /total (R\$ [\d.,]+)/.exec(content)?.[1];
      return total ? `resumo gerado: ${total}` : "resumo gerado";
    }
    case "confirmar_pedido": {
      const sale = /Venda (\d+) criada/.exec(content)?.[1];
      if (sale) return `venda ${sale} criada`;
      const again = /venda (\d+)\)/.exec(content)?.[1];
      return again ? `já registrado antes (venda ${again})` : short(content);
    }
    case "consultar_pedido":
      return short(content);
    case "chamar_atendente": {
      const motivo = (input as { motivo?: unknown } | null)?.motivo;
      return typeof motivo === "string" ? short(`passou para atendente: ${motivo}`) : "passou para atendente";
    }
    default:
      return "concluída";
  }
}

/**
 * What the AI did, interleaved with the conversation, for the attendant. Built from llm_turns;
 * thinking blocks and raw tool content never leave this function.
 */
export async function buildTrace(db: Db, conversationId: string): Promise<TraceItem[]> {
  const [msgs, turns] = await Promise.all([
    db
      .select({ author: messages.author, text: messages.text, at: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
    db
      .select({ role: llmTurns.role, content: llmTurns.content, at: llmTurns.createdAt })
      .from(llmTurns)
      .where(eq(llmTurns.conversationId, conversationId))
      .orderBy(asc(llmTurns.id)),
  ]);

  const tools: (TraceItem & { kind: "tool" })[] = [];
  const pending = new Map<string, { name: string; input: unknown; at: Date }>();
  for (const turn of turns) {
    if (!Array.isArray(turn.content)) continue;
    for (const b of turn.content as Block[]) {
      if (turn.role === "assistant" && b.type === "tool_use" && b.id && b.name) {
        pending.set(b.id, { name: b.name, input: b.input, at: turn.at });
      } else if (turn.role === "user" && b.type === "tool_result" && b.tool_use_id) {
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        const isError = b.is_error === true;
        tools.push({ kind: "tool", name: call.name, summary: summarize(call.name, call.input, text(b.content), isError), isError, at: turn.at });
      }
    }
  }
  for (const call of pending.values()) tools.push({ kind: "tool", name: call.name, summary: "sem resultado", isError: false, at: call.at });

  const items: TraceItem[] = [...msgs.map((m) => ({ kind: "message" as const, ...m })), ...tools];
  // Stable: at equal times a message keeps its place before the tool events recorded after it.
  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}
