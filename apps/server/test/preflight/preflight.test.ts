import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { assessConfig, checkWhatsapp, formatReport, probeRoutes } from "../../src/preflight/preflight.js";
import { RateLimiter } from "../../src/revgas/rateLimiter.js";

const KEY = "preflight-secret-key-never-printed";
const base = { DATABASE_URL: "postgres://x", REVGAS_API_KEY: KEY, ANTHROPIC_API_KEY: "anthropic-secret-never-printed" };
const cfg = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env });

const warningsOf = (rows: ReturnType<typeof assessConfig>, name: string) => rows.find((r) => r.name === name)!.warnings.join(" | ");

describe("assessConfig", () => {
  it("lists every RevGás-dependent option with its current value", () => {
    const rows = assessConfig(cfg({ REVGAS_PRODUCT_IDS: "23740,23974" }), []);
    expect(rows.map((r) => r.name)).toEqual([
      "REVGAS_WRITE_ENABLED",
      "REVGAS_BASE_URL",
      "REVGAS_BROADCAST",
      "REVGAS_CUSTOMERS_ENABLED",
      "REVGAS_VALEGAS_ENABLED",
      "REVGAS_PRICE_PRIORITY",
      "REVGAS_PRODUCT_IDS",
    ]);
    expect(rows.find((r) => r.name === "REVGAS_PRODUCT_IDS")!.value).toBe("23740,23974");
    expect(rows.find((r) => r.name === "REVGAS_WRITE_ENABLED")!.value).toBe("false");
  });

  it("has no warnings on the safe defaults besides the empty product list", () => {
    const rows = assessConfig(cfg({ REVGAS_PRODUCT_IDS: "23740" }), []);
    expect(rows.flatMap((r) => r.warnings)).toEqual([]);
  });

  it("warns about real sales without notifying deliverers", () => {
    const rows = assessConfig(cfg({ REVGAS_WRITE_ENABLED: "true", REVGAS_BROADCAST: "NONE" }), []);
    expect(warningsOf(rows, "REVGAS_BROADCAST")).toContain("vendas reais sem avisar entregador");
    expect(warningsOf(rows, "REVGAS_WRITE_ENABLED")).toContain("vendas reais");
  });

  it("warns that NEW_SALE with writes on notifies real deliverers", () => {
    const rows = assessConfig(cfg({ REVGAS_WRITE_ENABLED: "true", REVGAS_BROADCAST: "NEW_SALE" }), []);
    expect(warningsOf(rows, "REVGAS_BROADCAST")).toContain("entregadores reais");
  });

  it("warns about the homologation server the spec says not to use", () => {
    const rows = assessConfig(cfg({ REVGAS_BASE_URL: "https://apihomologacao.revgas.com/v1" }), []);
    expect(warningsOf(rows, "REVGAS_BASE_URL")).toContain("Não utilizar");
  });

  it("warns that price priority does nothing without the customer lookup", () => {
    const rows = assessConfig(cfg({ REVGAS_PRICE_PRIORITY: "true" }), []);
    expect(warningsOf(rows, "REVGAS_PRICE_PRIORITY")).toContain("REVGAS_CUSTOMERS_ENABLED");
  });

  it("warns when the customer lookup is on but /customers answers 403", () => {
    const rows = assessConfig(cfg({ REVGAS_CUSTOMERS_ENABLED: "true" }), [{ route: "/customers", status: 403 }]);
    expect(warningsOf(rows, "REVGAS_CUSTOMERS_ENABLED")).toContain("403");
  });

  it("asks to confirm the coupon field when Vale Gás is on", () => {
    expect(warningsOf(assessConfig(cfg({ REVGAS_VALEGAS_ENABLED: "true" }), []), "REVGAS_VALEGAS_ENABLED")).toContain("serial");
  });

  it("notes that an empty product list offers every product with a deal", () => {
    expect(warningsOf(assessConfig(cfg(), []), "REVGAS_PRODUCT_IDS")).toContain("todos os produtos");
  });
});

describe("probeRoutes", () => {
  it("makes one GET per route with the key and reports each status, never a POST", async () => {
    const statuses: Record<string, number> = { "/products": 200, "/customers": 403, "/deals": 200, "/sales": 200 };
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace("/v1", "");
      return new Response("{}", { status: statuses[path] ?? 500 });
    });
    const probes = await probeRoutes(cfg(), new RateLimiter(0), fetchFn as unknown as typeof fetch);
    expect(probes).toEqual([
      { route: "/products", status: 200 },
      { route: "/customers", status: 403 },
      { route: "/deals", status: 200 },
      { route: "/sales", status: 200 },
    ]);
    for (const [url, init] of fetchFn.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(KEY);
      expect(String(url)).not.toContain(KEY);
    }
    expect(String(fetchFn.mock.calls[0]![0])).toContain("/products?establishment_id=2580&page=1&page_size=1");
  });

  it("reports a network failure instead of throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const probes = await probeRoutes(cfg(), new RateLimiter(0), fetchFn as unknown as typeof fetch);
    expect(probes.every((p) => p.status === "erro de rede")).toBe(true);
  });
});

describe("formatReport", () => {
  it("prints the table, the warnings and the probes without any key", () => {
    const c = cfg({ REVGAS_WRITE_ENABLED: "true" });
    const probes = [{ route: "/products", status: 200 as const }, { route: "/customers", status: 403 as const }];
    const text = formatReport(assessConfig(c, probes), probes);
    expect(text).toContain("REVGAS_WRITE_ENABLED");
    expect(text).toContain("vendas reais sem avisar entregador");
    expect(text).toContain("GET /customers");
    expect(text).toContain("403");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("anthropic-secret-never-printed");
  });
});

describe("checkWhatsapp", () => {
  const WAHA_KEY = "waha-key-never-printed";
  const waha = (env: Record<string, string> = {}) =>
    cfg({ WHATSAPP_PROVIDER: "waha", WAHA_API_KEY: WAHA_KEY, WAHA_WEBHOOK_SECRET: "webhook-secret-never-printed", ...env });
  const answering = (status: number, body: unknown = {}) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  const rowsText = (rows: Awaited<ReturnType<typeof checkWhatsapp>>) => rows.map((r) => `${r.name} ${r.value} ${r.warnings.join(" | ")}`).join("\n");

  it("off: one row and no call to WAHA", async () => {
    const fetchFn = answering(200);
    const rows = await checkWhatsapp(cfg(), fetchFn as unknown as typeof fetch);
    expect(rows).toEqual([{ name: "WHATSAPP_PROVIDER", value: "off", warnings: [] }]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("WORKING session: ok, asked with the key, and the fixed unofficial warning", async () => {
    const fetchFn = answering(200, { name: "default", status: "WORKING" });
    const rows = await checkWhatsapp(waha({ WHATSAPP_ALLOWED_NUMBERS: "86911112222" }), fetchFn as unknown as typeof fetch);
    expect(String(fetchFn.mock.calls[0]![0])).toBe("http://localhost:3002/api/sessions/default");
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get("x-api-key")).toBe(WAHA_KEY);
    expect(rows.find((r) => r.name === "WAHA_SESSION")).toEqual({ name: "WAHA_SESSION", value: "default: WORKING", warnings: [] });
    expect(rows.find((r) => r.name === "WHATSAPP_PROVIDER")!.warnings).toEqual(["WAHA não é oficial: use chip reserva"]);
    expect(rows.find((r) => r.name === "WHATSAPP_ALLOWED_NUMBERS")!.warnings).toEqual([]);
  });

  it("SCAN_QR_CODE: warns to scan the QR", async () => {
    const rows = await checkWhatsapp(waha(), answering(200, { status: "SCAN_QR_CODE" }) as unknown as typeof fetch);
    expect(rows.find((r) => r.name === "WAHA_SESSION")!.warnings.join()).toContain("escaneie o QR");
  });

  it("WAHA down: 'WAHA não respondeu'", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const rows = await checkWhatsapp(waha(), fetchFn as unknown as typeof fetch);
    expect(rows.find((r) => r.name === "WAHA_SESSION")!.warnings.join()).toContain("WAHA não respondeu");
  });

  it("a wrong key: says WAHA refused WAHA_API_KEY", async () => {
    const rows = await checkWhatsapp(waha(), answering(401) as unknown as typeof fetch);
    expect(rows.find((r) => r.name === "WAHA_SESSION")!.warnings.join()).toContain("WAHA_API_KEY");
  });

  it("warns when anyone can use the bot, and never prints the secrets", async () => {
    const rows = await checkWhatsapp(waha(), answering(200, { status: "WORKING" }) as unknown as typeof fetch);
    expect(rows.find((r) => r.name === "WHATSAPP_ALLOWED_NUMBERS")!.warnings.join()).toContain(
      "qualquer pessoa que souber o número usa o bot e gasta créditos da IA",
    );
    const text = formatReport(assessConfig(waha(), []), [], rows) + rowsText(rows);
    expect(text).toContain("WhatsApp");
    expect(text).not.toContain(WAHA_KEY);
    expect(text).not.toContain("webhook-secret-never-printed");
  });
});
