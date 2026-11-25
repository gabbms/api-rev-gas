import type { AppConfig } from "../config.js";
import type { RateLimiter } from "../revgas/rateLimiter.js";

export type Probe = { route: string; status: number | "erro de rede" };
export type Row = { name: string; value: string; warnings: string[] };

const PRODUCTION = "https://api.revgas.com/v1";
const HOMOLOGATION = "https://apihomologacao.revgas.com/v1";

/** Every option that depends on an answer from RevGás, its value and what is risky about it. Never keys. */
export function assessConfig(cfg: AppConfig, probes: Probe[]): Row[] {
  const status = (route: string) => probes.find((p) => p.route === route)?.status;
  const write = cfg.revgasWriteEnabled;
  const rows: Row[] = [];

  rows.push({
    name: "REVGAS_WRITE_ENABLED",
    value: String(write),
    warnings: write ? ["ATENÇÃO: vendas reais serão criadas na RevGás"] : [],
  });

  const urlWarnings: string[] = [];
  if (cfg.revgasBaseUrl === HOMOLOGATION) {
    urlWarnings.push("servidor de homologação: a spec diz \"Não utilizar\"; use só com autorização da RevGás");
  } else if (cfg.revgasBaseUrl !== PRODUCTION) {
    urlWarnings.push("URL desconhecida (nem produção nem homologação)");
  } else if (write) {
    urlWarnings.push("escrita ligada em produção");
  }
  rows.push({ name: "REVGAS_BASE_URL", value: cfg.revgasBaseUrl, warnings: urlWarnings });

  const broadcast: string[] = [];
  if (write && cfg.revgasBroadcast === "NONE") broadcast.push("vendas reais sem avisar entregador");
  if (write && cfg.revgasBroadcast === "NEW_SALE") broadcast.push("vendas reais vão notificar entregadores reais");
  if (!write && cfg.revgasBroadcast === "NEW_SALE") broadcast.push("sem efeito enquanto a escrita está desligada");
  rows.push({ name: "REVGAS_BROADCAST", value: cfg.revgasBroadcast, warnings: broadcast });

  const customers: string[] = [];
  if (cfg.revgasCustomersEnabled && status("/customers") === 403) {
    customers.push("ligado, mas o token recebe 403 em /customers: nenhum cliente será identificado na RevGás");
  }
  rows.push({ name: "REVGAS_CUSTOMERS_ENABLED", value: String(cfg.revgasCustomersEnabled), warnings: customers });

  rows.push({
    name: "REVGAS_VALEGAS_ENABLED",
    value: String(cfg.revgasValegasEnabled),
    warnings: cfg.revgasValegasEnabled ? ["confirme com a RevGás que o código do cupom vai em payments[].serial"] : [],
  });

  const priority: string[] = [];
  if (cfg.revgasPricePriority && !cfg.revgasCustomersEnabled) {
    priority.push("sem efeito: precisa de REVGAS_CUSTOMERS_ENABLED=true para identificar o cliente");
  }
  if (cfg.revgasPricePriority && status("/deals") === 403) priority.push("o token recebe 403 em /deals");
  rows.push({ name: "REVGAS_PRICE_PRIORITY", value: String(cfg.revgasPricePriority), warnings: priority });

  rows.push({
    name: "REVGAS_PRODUCT_IDS",
    value: cfg.revgasProductIds ? cfg.revgasProductIds.join(",") : "(vazio)",
    warnings: cfg.revgasProductIds ? [] : ["vazio: todos os produtos com acordo são oferecidos, inclusive os de teste do 2580"],
  });
  return rows;
}

/** One GET per route the bot uses. Never writes. */
export async function probeRoutes(cfg: AppConfig, limiter: RateLimiter, fetchFn: typeof fetch = fetch): Promise<Probe[]> {
  const est = cfg.revgasEstablishmentId;
  const routes: [string, string][] = [
    ["/products", `/products?establishment_id=${est}&page=1&page_size=1`],
    ["/customers", "/customers?phone=86999998888"],
    ["/deals", `/deals?establishment_id=${est}&customer_isnull=true&tag_isnull=true&page=1&page_size=1`],
    ["/sales", "/sales?page=1&page_size=1"],
  ];
  const probes: Probe[] = [];
  for (const [route, path] of routes) {
    try {
      const res = await limiter.schedule(() =>
        fetchFn(`${cfg.revgasBaseUrl}${path}`, {
          method: "GET",
          headers: { Authorization: cfg.revgasApiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        }),
      );
      probes.push({ route, status: res.status });
    } catch {
      probes.push({ route, status: "erro de rede" });
    }
  }
  return probes;
}

/** WHATSAPP_PROVIDER and, with waha, the WAHA session status. Off: no call at all. Never prints keys. */
export async function checkWhatsapp(cfg: AppConfig, fetchFn: typeof fetch = fetch): Promise<Row[]> {
  if (cfg.whatsappProvider === "off") return [{ name: "WHATSAPP_PROVIDER", value: "off", warnings: [] }];
  const rows: Row[] = [{ name: "WHATSAPP_PROVIDER", value: "waha", warnings: ["WAHA não é oficial: use chip reserva"] }];

  const session = cfg.wahaSession;
  let value = `${session}: ?`;
  const warnings: string[] = [];
  try {
    const res = await fetchFn(`${cfg.wahaUrl}/api/sessions/${encodeURIComponent(session)}`, {
      headers: { "X-Api-Key": cfg.wahaApiKey ?? "", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) warnings.push("WAHA recusou WAHA_API_KEY: confira o .env e suba o WAHA de novo");
    else if (res.status === 404) warnings.push(`a sessão ${session} não existe: inicie-a no painel do WAHA`);
    else if (!res.ok) warnings.push(`WAHA respondeu HTTP ${res.status}`);
    else {
      const body = (await res.json().catch(() => ({}))) as { status?: unknown };
      const status = typeof body.status === "string" ? body.status : "?";
      value = `${session}: ${status}`;
      if (status !== "WORKING") warnings.push("sessão não conectada: escaneie o QR no painel do WAHA (http://localhost:3002/dashboard)");
    }
  } catch {
    warnings.push(`WAHA não respondeu em ${cfg.wahaUrl}: suba com docker compose -f docker-compose.waha.yml up -d`);
  }
  rows.push({ name: "WAHA_SESSION", value, warnings });

  rows.push({
    name: "WHATSAPP_ALLOWED_NUMBERS",
    value: cfg.whatsappAllowedNumbers ? cfg.whatsappAllowedNumbers.join(",") : "(vazio)",
    warnings: cfg.whatsappAllowedNumbers ? [] : ["vazio: qualquer pessoa que souber o número usa o bot e gasta créditos da IA"],
  });
  return rows;
}

/**
 * AUDIO_TRANSCRIPTION and, with groq, whether the key works: a read-only GET /models (no audio is
 * sent). Off: no request. Never prints the key or the response body.
 */
export async function checkAudio(cfg: AppConfig, fetchFn: typeof fetch = fetch): Promise<Row[]> {
  if (cfg.audioTranscription === "off") return [{ name: "AUDIO_TRANSCRIPTION", value: "off", warnings: [] }];
  const warnings = ["o áudio do cliente é enviado à Groq"];
  const modelsUrl = cfg.transcribeUrl.replace(/\/audio\/transcriptions\/?$/, "/models");
  let status: string;
  try {
    const res = await fetchFn(modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.groqApiKey ?? ""}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) status = "ok";
    else if (res.status === 401 || res.status === 403) {
      status = "chave recusada";
      warnings.push("a Groq recusou GROQ_API_KEY: gere outra no console da Groq");
    } else {
      status = `HTTP ${res.status}`;
      warnings.push(`a Groq respondeu HTTP ${res.status}`);
    }
  } catch {
    status = "sem resposta";
    warnings.push("a Groq não respondeu: confira a internet e TRANSCRIBE_URL");
  }
  return [{ name: "AUDIO_TRANSCRIPTION", value: `groq (${cfg.transcribeModel}): ${status}`, warnings }];
}

function table(rows: Row[]): string[] {
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const valueW = Math.max(...rows.map((r) => r.value.length));
  return rows.map((r) => `${r.name.padEnd(nameW)}  ${r.value.padEnd(valueW)}  ${r.warnings.length ? "⚠ " + r.warnings.join("; ") : "ok"}`);
}

export function formatReport(rows: Row[], probes: Probe[], whatsapp: Row[] = []): string {
  const lines = ["Configuração que depende da RevGás", "", ...table(rows)];
  lines.push("", "Leituras de teste (só GET, nenhuma escrita)", "");
  for (const p of probes) {
    const label = p.status === 200 ? "200 ok" : p.status === 403 ? "403 sem acesso" : String(p.status);
    lines.push(`GET ${p.route.padEnd(11)} ${label}`);
  }
  if (whatsapp.length) lines.push("", "WhatsApp", "", ...table(whatsapp));
  const total = [...rows, ...whatsapp].reduce((n, r) => n + r.warnings.length, 0);
  lines.push("", total === 0 ? "Nenhum aviso." : `${total} aviso(s).`);
  return lines.join("\n");
}
