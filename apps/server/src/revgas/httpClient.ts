import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { normalizePhone } from "./phone.js";
import { RateLimiter } from "./rateLimiter.js";
import { SimulatedSales } from "./simulatedSales.js";
import {
  RevgasError,
  customerSchema,
  dealPageSchema,
  productPageSchema,
  saleSchema,
  type RevgasClient,
  type RevgasCustomer,
  type DealFilter,
  type RevgasDeal,
  type RevgasErrorKind,
  type RevgasProduct,
  type RevgasSale,
  type SalePayload,
} from "./types.js";

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE: ReadonlySet<RevgasErrorKind> = new Set(["rate_limited", "conflict_lock"]);

const customerListSchema = z.union([z.array(customerSchema), z.object({ data: z.array(customerSchema) })]);
const saleResponseSchema = z.union([z.object({ data: saleSchema }), saleSchema]);

export class HttpRevgasClient implements RevgasClient {
  constructor(
    private readonly cfg: AppConfig,
    private readonly limiter: RateLimiter,
    private readonly fetchFn: typeof fetch = fetch,
    /** Extra pause before retrying 429 / 409-lock, on top of the limiter spacing. */
    private readonly retryDelayMs = 2000,
  ) {}

  async findCustomersByPhone(phone: string): Promise<RevgasCustomer[]> {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new RevgasError("invalid", "Telefone inválido", 422);
    const body = await this.request("GET", `/customers?phone=${normalized}`);
    const parsed = this.parse(customerListSchema, body);
    return Array.isArray(parsed) ? parsed : parsed.data;
  }

  async listProducts(establishmentId: number): Promise<RevgasProduct[]> {
    const all: RevgasProduct[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request(
        "GET",
        `/products?establishment_id=${establishmentId}&page=${page}&page_size=100`,
      );
      const parsed = this.parse(productPageSchema, body);
      all.push(...parsed.data);
      if (!parsed.pagination?.has_next) return all;
    }
  }

  async listDeals(establishmentId: number): Promise<RevgasDeal[]> {
    return this.dealPages(`establishment_id=${establishmentId}&customer_isnull=true&tag_isnull=true`);
  }

  async listDealsBy(establishmentId: number, filter: DealFilter): Promise<RevgasDeal[]> {
    const by = "customerId" in filter ? `customer_id=${filter.customerId}` : `tag_id=${filter.tagId}`;
    return this.dealPages(`establishment_id=${establishmentId}&${by}`);
  }

  private async dealPages(query: string): Promise<RevgasDeal[]> {
    const all: RevgasDeal[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request("GET", `/deals?${query}&page=${page}&page_size=100`);
      const parsed = this.parse(dealPageSchema, body);
      all.push(...parsed.data);
      if (!parsed.pagination?.has_next) return all;
    }
  }

  async createSale(payload: SalePayload): Promise<RevgasSale> {
    const body = await this.request("POST", "/sales", payload);
    return this.unwrapSale(body);
  }

  async getSale(id: number): Promise<RevgasSale> {
    const body = await this.request("GET", `/sales/${id}`);
    return this.unwrapSale(body);
  }

  private unwrapSale(body: unknown): RevgasSale {
    const parsed = this.parse(saleResponseSchema, body);
    return "data" in parsed ? parsed.data : parsed;
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new RevgasError("server", "Resposta inesperada da RevGás");
    return result.data;
  }

  /**
   * Retries only 429 and 409-lock (RevGás did not process the request).
   * Server errors and network failures are never retried: for POST /sales the
   * outcome is unknown and must be checked by a human.
   */
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limiter.schedule(() => this.once(method, path, body));
      } catch (e) {
        if (e instanceof RevgasError && RETRYABLE.has(e.kind) && attempt < MAX_RETRIES) {
          if (this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  private async once(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.revgasBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.cfg.revgasApiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new RevgasError("network", "Falha de rede ou tempo esgotado ao falar com a RevGás");
    }

    const text = await res.text().catch(() => "");
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return json;

    const apiMessage = this.redact(
      typeof json === "object" && json !== null && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : `HTTP ${res.status}`,
    );
    if (res.status === 403) {
      // C6: name the route (without query) so logs say exactly what the token can't reach.
      throw new RevgasError("auth", `Token sem acesso a ${path.split("?")[0]}`, 403);
    }
    throw new RevgasError(classify(res.status, apiMessage, json), apiMessage, res.status);
  }

  private redact(text: string): string {
    const key = this.cfg.revgasApiKey;
    return key ? text.split(key).join("***") : text;
  }
}

function classify(status: number, message: string, body: unknown): RevgasErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 409) {
    if (/lock/i.test(message)) return "conflict_lock";
    const data = (body as { data?: unknown } | undefined)?.data;
    if (Array.isArray(data) && data.some((d) => typeof d === "object" && d !== null && "value_id" in d)) {
      return "duplicate";
    }
    // Unknown 409: treat as duplicate (never retried) — safer than risking a second sale.
    return "duplicate";
  }
  if (status >= 500) return "server";
  return "invalid";
}

/**
 * Reads always go to the real API. With writes disabled, sales are simulated and stored in our
 * database (they survive restarts), and simulated sales are read back from there.
 */
export function createRevgasClient(cfg: AppConfig, db: Db, fetchFn: typeof fetch = fetch): RevgasClient {
  const http = new HttpRevgasClient(cfg, new RateLimiter(1000), fetchFn);
  if (cfg.revgasWriteEnabled) return http;

  const simulated = new SimulatedSales(db);
  return {
    findCustomersByPhone: (phone) => http.findCustomersByPhone(phone),
    listProducts: (id) => http.listProducts(id),
    listDeals: (id) => http.listDeals(id),
    listDealsBy: (id, filter) => http.listDealsBy(id, filter),
    createSale: async (payload) => {
      console.info("[revgas] escrita desligada: venda simulada");
      return simulated.create(payload);
    },
    getSale: async (id) => (await simulated.find(id)) ?? http.getSale(id),
  };
}
