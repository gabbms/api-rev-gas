import type { ConversationSummary } from "@revgas/shared";
import { useEffect, useState } from "react";
import { AttendantPane } from "./AttendantPane";
import { ChatPane } from "./ChatPane";
import { useOnline, useServerMessages } from "./ws";

export function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [version, setVersion] = useState(0);
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
        <AttendantPane conversations={conversations} version={version} />
      </main>
    </div>
  );
}
