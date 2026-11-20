import type { ConversationSummary, HistoryItem } from "@revgas/shared";
import { useEffect, useState, type FormEvent } from "react";
import { MessageText, time } from "./MessageText";
import { connection, formatPhone } from "./ws";

const AUTHOR_LABEL: Record<string, string> = { customer: "Cliente", bot: "Bot", attendant: "Atendente", system: "Sistema" };

export function AttendantPane({ conversations, version }: { conversations: ConversationSummary[]; version: number }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [reply, setReply] = useState("");
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // Every change on the server bumps `version`; refetch the open conversation.
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    void fetch(`/conversations/${selectedId}/messages`)
      .then((r) => r.json() as Promise<{ items: HistoryItem[] }>)
      .then((body) => alive && setHistory(body.items));
    return () => {
      alive = false;
    };
  }, [selectedId, version]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = reply.trim();
    if (!text || !selected) return;
    if (connection.send({ type: "attendant_reply", conversationId: selected.id, text })) setReply("");
  }

  const waitingCount = conversations.filter((c) => c.mode === "human").length;

  return (
    <section className="desk" aria-label="Atendimento">
      <header className="desk-head">
        <h2>Atendimento</h2>
        <p>
          {waitingCount === 0
            ? "Nenhuma conversa aguardando atendente."
            : waitingCount === 1
              ? "1 conversa aguardando atendente."
              : `${waitingCount} conversas aguardando atendente.`}
        </p>
      </header>

      <div className="desk-body">
        <ul className="conv-list">
          {conversations.length === 0 && <li className="empty">As conversas aparecem aqui quando um cliente escrever.</li>}
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                className={`conv ${c.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(c.id)}
                aria-pressed={c.id === selectedId}
              >
                <span className="conv-phone">{formatPhone(c.phone)}</span>
                <span className={`badge ${c.mode}`}>{c.mode === "human" ? "Humano" : "Bot"}</span>
                {c.handoffReason && <span className="conv-reason">{c.handoffReason}</span>}
                <span className="conv-time">{time(c.lastMessageAt)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="conv-detail">
          {!selected ? (
            <p className="empty">Escolha uma conversa para ver as mensagens.</p>
          ) : (
            <>
              <div className="detail-head">
                <strong>{formatPhone(selected.phone)}</strong>
                {selected.mode === "human" ? (
                  <button className="ghost" onClick={() => connection.send({ type: "return_to_bot", conversationId: selected.id })}>
                    Devolver ao bot
                  </button>
                ) : (
                  <span className="muted">O bot está atendendo.</span>
                )}
              </div>
              <ol className="log">
                {history.map((m, i) => (
                  <li key={i} className={`log-${m.author}`}>
                    <span className="log-who">{AUTHOR_LABEL[m.author] ?? m.author}</span>
                    <span className="log-text">
                      <MessageText text={m.text} />
                    </span>
                    <time>{time(m.createdAt)}</time>
                  </li>
                ))}
              </ol>
              {selected.mode === "human" && (
                <form className="composer" onSubmit={submit}>
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Responder como atendente"
                    aria-label="Resposta do atendente"
                  />
                  <button type="submit" disabled={!reply.trim()}>
                    Responder
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
