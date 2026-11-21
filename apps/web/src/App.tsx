import type { ConversationSummary } from "@revgas/shared";
import { useEffect, useState } from "react";
import { AttendantPane } from "./AttendantPane";
import { ChatPane } from "./ChatPane";
import { MetricsPane } from "./MetricsPane";
import { useOnline, useServerMessages } from "./ws";

export function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<"desk" | "metrics">("desk");
  const [writeEnabled, setWriteEnabled] = useState<boolean | null>(null);
  const online = useOnline();

  useEffect(() => {
    void fetch("/health")
      .then((r) => r.json() as Promise<{ revgasWriteEnabled: boolean }>)
      .then((h) => setWriteEnabled(h.revgasWriteEnabled))
      .catch(() => setWriteEnabled(null));
  }, [online]);

  useServerMessages((msg) => {
    if (msg.type === "conversations") {
      setConversations(msg.items);
      setVersion((v) => v + 1);
    } else if (msg.type === "message") {
      setVersion((v) => v + 1);
    }
  });

  return (
    <div className="app">
      {writeEnabled === false && (
        <div className="test-band" role="status">
          <span>Modo de teste — vendas NÃO são enviadas à RevGás</span>
        </div>
      )}
      {writeEnabled === true && (
        <div className="live-band" role="status">
          Atenção: vendas confirmadas são criadas de verdade na RevGás
        </div>
      )}
      {!online && <div className="offline">Sem conexão com o servidor. Tentando reconectar…</div>}
      <main className="columns">
        <ChatPane conversations={conversations} />
        <div className="side">
          <nav className="tabs" role="tablist" aria-label="Painéis">
            <button role="tab" aria-selected={tab === "desk"} className={tab === "desk" ? "active" : ""} onClick={() => setTab("desk")}>
              Atendimento
            </button>
            <button role="tab" aria-selected={tab === "metrics"} className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
              Métricas
            </button>
          </nav>
          {tab === "desk" ? (
            <AttendantPane conversations={conversations} version={version} />
          ) : (
            <MetricsPane version={version} />
          )}
        </div>
      </main>
    </div>
  );
}
