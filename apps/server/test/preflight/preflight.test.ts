import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { assessConfig, formatReport, probeRoutes } from "../../src/preflight/preflight.js";
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
