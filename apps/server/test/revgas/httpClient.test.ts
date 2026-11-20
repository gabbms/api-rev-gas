import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { HttpRevgasClient, createRevgasClient } from "../../src/revgas/httpClient.js";
import { RateLimiter } from "../../src/revgas/rateLimiter.js";
import { RevgasError, type SalePayload } from "../../src/revgas/types.js";

const KEY = "test-revgas-key-should-never-leak";
const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: KEY, ANTHROPIC_API_KEY: "a" });

type Call = { url: string; init: RequestInit | undefined };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const client = (f: typeof fetch) => new HttpRevgasClient(cfg, new RateLimiter(0), f, 0);

const sale: SalePayload = {
  location: "Rua A",
  number: "1",
  neighborhood: "Centro",
  city: "Teresina",
  state_federation: "PI",
  establishment_id: 2580,
  products: [{ product_id: 23740, quantity: 1, value: 110 }],
  payments: [{ payment_type: "PIX", value: 110 }],
  channel: "WHATSAPP",
  origin: "INTEGRATION",
  option: "NORMAL",
  broadcast: "NONE",
};

async function errorOf(p: Promise<unknown>): Promise<RevgasError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RevgasError);
    return e as RevgasError;
  }
  throw new Error("expected rejection");
}

describe("HttpRevgasClient", () => {
  it("sends the key in the Authorization header without Bearer", async () => {
    const f = fakeFetch(json(200, { data: [], pagination: { has_next: false } }));
    await client(f.fn).listProducts(2580);
    const headers = new Headers(f.calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe(KEY);
  });

  it("never puts the key in error messages", async () => {
    const f = fakeFetch(json(401, { message: `invalid token ${KEY}` }));
    const err = await errorOf(client(f.fn).listProducts(2580));
    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("normalizes the phone before searching customers", async () => {
    const f = fakeFetch(json(200, { data: [{ id: 7, name: "Maria" }] }));
    const found = await client(f.fn).findCustomersByPhone("+55 86 99999-8888");
    expect(f.calls[0]!.url).toBe("https://api.revgas.com/v1/customers?phone=86999998888");
    expect(found[0]).toMatchObject({ id: 7, name: "Maria", location: null });
  });

  it("rejects an invalid phone without calling the API", async () => {
    const f = fakeFetch();
    const err = await errorOf(client(f.fn).findCustomersByPhone("123"));
    expect(err.kind).toBe("invalid");
    expect(f.calls).toHaveLength(0);
  });

  it("joins every page of products", async () => {
    const f = fakeFetch(
      json(200, {
        data: [{ id: 1, description: "A", inactive: false, establishment_id: 2580, extra: "x" }],
        pagination: { has_next: true },
      }),
      json(200, {
        data: [{ id: 2, description: "B", inactive: true, establishment_id: 2580 }],
        pagination: { has_next: false },
      }),
    );
    const products = await client(f.fn).listProducts(2580);
    expect(products.map((p) => p.id)).toEqual([1, 2]);
    expect(f.calls[0]!.url).toBe("https://api.revgas.com/v1/products?establishment_id=2580&page=1&page_size=100");
    expect(f.calls[1]!.url).toContain("page=2");
  });

  it.each([
    [400, { message: "bad" }, "invalid"],
    [422, { message: "bad" }, "invalid"],
    [401, { message: "no" }, "auth"],
    [402, { message: "no" }, "auth"],
    [403, { message: "no" }, "auth"],
    [409, { message: "duplicated", data: [{ value_id: 5 }] }, "duplicate"],
    [500, { message: "oops" }, "server"],
    [503, {}, "server"],
  ] as const)("maps HTTP %i to %s", async (status, body, kind) => {
    const f = fakeFetch(json(status, body));
    const err = await errorOf(client(f.fn).createSale(sale));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it("maps a network failure to network", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    const err = await errorOf(client(f.fn).getSale(1));
    expect(err.kind).toBe("network");
  });

  it("maps a timeout to network", async () => {
    const f = fakeFetch(new DOMException("timed out", "TimeoutError"));
    const err = await errorOf(client(f.fn).getSale(1));
    expect(err.kind).toBe("network");
  });

  it("retries 429 and then succeeds", async () => {
    const f = fakeFetch(json(429, { message: "slow down" }), json(200, { id: 9, status: "OPEN", total: 110 }));
    const result = await client(f.fn).createSale(sale);
    expect(result).toMatchObject({ id: 9, status: "OPEN", total: 110 });
    expect(f.calls).toHaveLength(2);
  });

  it("retries a 409 lock up to 3 times, then gives up as conflict_lock", async () => {
    const lock = () => json(409, { message: "Resource lock, try again" });
    const f = fakeFetch(lock(), lock(), lock(), lock());
    const err = await errorOf(client(f.fn).createSale(sale));
    expect(err.kind).toBe("conflict_lock");
    expect(f.calls).toHaveLength(4);
  });

  it("gives up on 429 after 3 retries", async () => {
    const r = () => json(429, {});
    const f = fakeFetch(r(), r(), r(), r());
    const err = await errorOf(client(f.fn).listProducts(2580));
    expect(err.kind).toBe("rate_limited");
    expect(f.calls).toHaveLength(4);
  });

  it.each([
    ["server", () => json(500, { message: "oops" })],
    ["network", () => new TypeError("fetch failed")],
  ] as const)("does not retry createSale on %s", async (_kind, make) => {
    const f = fakeFetch(make(), json(200, { id: 1, status: "OPEN", total: 1 }));
    await errorOf(client(f.fn).createSale(sale));
    expect(f.calls).toHaveLength(1);
  });

  it("posts the sale as JSON to /sales", async () => {
    const f = fakeFetch(json(201, { data: { id: 77, status: "OPEN", total: 110 } }));
    const result = await client(f.fn).createSale(sale);
    expect(result.id).toBe(77);
    expect(f.calls[0]!.url).toBe("https://api.revgas.com/v1/sales");
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual(sale);
  });

  it("reads a sale by id", async () => {
    const f = fakeFetch(json(200, { id: 30930462, status: "CANCEL", total: 110, channel: "WHATSAPP" }));
    const result = await client(f.fn).getSale(30930462);
    expect(result).toMatchObject({ id: 30930462, status: "CANCEL", total: 110 });
    expect(f.calls[0]!.url).toBe("https://api.revgas.com/v1/sales/30930462");
  });
});

describe("createRevgasClient", () => {
  it("does not call the API for createSale when writes are disabled", async () => {
    const f = fakeFetch();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const c = createRevgasClient(cfg, f.fn);
    const created = await c.createSale(sale);
    expect(f.calls).toHaveLength(0);
    expect(created.status).toBe("OPEN");
    expect(info).toHaveBeenCalledWith("[revgas] escrita desligada: venda simulada");
    expect(await c.getSale(created.id)).toMatchObject({ id: created.id });
    expect(f.calls).toHaveLength(0);
    info.mockRestore();
  });

  it("still reads from the real API when writes are disabled", async () => {
    const f = fakeFetch(json(200, { data: [], pagination: { has_next: false } }));
    await createRevgasClient(cfg, f.fn).listProducts(2580);
    expect(f.calls).toHaveLength(1);
  });
});
