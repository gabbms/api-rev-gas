import type { Author, ConversationSummary, HistoryItem } from "@revgas/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageText, time } from "./MessageText";
import { connection, formatPhone, normalizePhone, useServerMessages } from "./ws";

type Line = { author: Author; text: string; createdAt: string };

export function ChatPane({ conversations }: { conversations: ConversationSummary[] }) {
  const [phoneInput, setPhoneInput] = useState("86999998888");
  const phone = normalizePhone(phoneInput);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const conversation = conversations.find((c) => c.phone === phone);
  // Typing here would speak as a real WhatsApp customer: the server refuses it, and so does the form.
  const isWhatsApp = conversation?.channel === "whatsapp";

  // Load the stored history once per phone, as soon as its conversation exists.
  useEffect(() => {
    if (!phone) {
      setLines([]);
      loadedFor.current = null;
      return;
    }
    if (loadedFor.current === phone) return;
    if (!conversation) {
      setLines([]);
      return;
    }
    loadedFor.current = phone;
    void fetch(`/conversations/${conversation.id}/messages`)
      .then((r) => r.json() as Promise<{ items: HistoryItem[] }>)
      .then((body) => setLines(body.items));
  }, [phone, conversation]);

  useServerMessages((msg) => {
    if (msg.type === "message" && msg.phone === phone && msg.author !== "customer") {
      setLines((prev) => [...prev, msg]);
      setWaiting(false);
    } else if (msg.type === "error") {
      setProblem(msg.message);
      setWaiting(false);
    }
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines, waiting]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !phone || isWhatsApp) return;
    if (!connection.send({ type: "customer_message", phone, text })) {
      setProblem("Sem conexão com o servidor. Verifique se ele está rodando e tente de novo.");
      return;
    }
    if (!loadedFor.current) loadedFor.current = phone;
    setProblem(null);
    setLines((prev) => [...prev, { author: "customer", text, createdAt: new Date().toISOString() }]);
    setDraft("");
    setWaiting(conversation?.mode !== "human");
  }

  return (
    <section className="phone" aria-label="Cliente (WhatsApp simulado)">
      <header className="phone-head">
        <h2>Cliente (WhatsApp simulado)</h2>
        <label className="phone-field">
          <span>Mensagem enviada do número</span>
          <input
            value={phoneInput}
            onChange={(e) => {
              setPhoneInput(e.target.value);
              loadedFor.current = null;
            }}
            inputMode="tel"
            aria-invalid={!phone}
          />
        </label>
        {!phone && <p className="field-error">Use DDD + número, ex.: 86999998888.</p>}
        {isWhatsApp && <p className="field-note">Esta conversa é do WhatsApp; responda pelo painel.</p>}
      </header>

      <div className="thread" ref={scroller} aria-live="polite">
        {lines.length === 0 && phone && (
          <p className="empty">Escreva como cliente, por exemplo: “quero um botijão, pago no pix”.</p>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`bubble ${l.author === "customer" ? "mine" : "theirs"} by-${l.author}`}>
            {l.author === "attendant" && <span className="who">Atendente</span>}
            <MessageText text={l.text} />
            <time>{time(l.createdAt)}</time>
          </div>
        ))}
        {waiting && <div className="bubble theirs typing" aria-label="Bot digitando">digitando…</div>}
      </div>

      {problem && <p className="field-error">{problem}</p>}
      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={phone ? `Mensagem de ${formatPhone(phone)}` : "Informe um telefone válido"}
          disabled={!phone || isWhatsApp}
          aria-label="Mensagem do cliente"
        />
        <button type="submit" disabled={!phone || isWhatsApp || !draft.trim()}>
          Enviar
        </button>
      </form>
    </section>
  );
}
