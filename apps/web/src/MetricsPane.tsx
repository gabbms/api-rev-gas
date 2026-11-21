import { metricsSchema, type Metrics } from "@revgas/shared";
import { useEffect, useState } from "react";

const money = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
}

/** Refetches whenever `version` changes (any server-side change), at most once per second. */
export function MetricsPane({ version }: { version: number }) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Metrics | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void fetch(`/metrics?from=${from}&to=${to}`)
        .then(async (r) => {
          const body: unknown = await r.json();
          if (!r.ok) throw new Error((body as { error?: string }).error ?? "Não foi possível carregar as métricas");
          return metricsSchema.parse(body);
        })
        .then((m) => {
          if (!alive) return;
          setData(m);
          setProblem(null);
        })
        .catch((e: unknown) => alive && setProblem(e instanceof Error ? e.message : String(e)));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [from, to, version]);

  const simulated = data?.simulated ? <span className="badge simulated">simulado</span> : null;

  return (
    <section className="metrics" aria-label="Métricas">
      <header className="metrics-head">
        <label>
          De <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          até <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted">Atualiza sozinho a cada mudança.</span>
      </header>
      {problem && <p className="field-error">{problem}</p>}
      {!data ? (
        <p className="empty">Carregando…</p>
      ) : (
        <div className="cards">
          <article className="card">
            <h3>Conversas atendidas</h3>
            <p className="big">{data.conversations}</p>
          </article>
          <article className="card">
            <h3>Resolvidas só pelo bot</h3>
            <p className="big">{data.botResolved}</p>
            <p className="muted">Taxa de automação: {data.automationRate.toLocaleString("pt-BR")}%</p>
          </article>
          <article className="card">
            <h3>Vendas {simulated}</h3>
            <p className="big">{data.sales.count}</p>
            <p className="muted">Total {money(data.sales.totalCents)}</p>
          </article>
          <article className="card">
            <h3>Ticket médio {simulated}</h3>
            <p className="big">{money(data.sales.averageTicketCents)}</p>
          </article>
          <article className="card">
            <h3>Passagens para humano</h3>
            <p className="big">{data.handoffs.total}</p>
            {data.handoffs.byReason.length > 0 && (
              <ul className="reasons">
                {data.handoffs.byReason.map((r) => (
                  <li key={r.reason}>
                    <span>{r.reason}</span>
                    <strong>{r.count}</strong>
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article className="card">
            <h3>Tempo médio de resposta do bot</h3>
            <p className="big">{duration(data.avgBotResponseMs)}</p>
          </article>
          <article className="card">
            <h3>Do "oi" ao pedido registrado</h3>
            <p className="big">{duration(data.avgTimeToOrderMs)}</p>
          </article>
        </div>
      )}
    </section>
  );
}
