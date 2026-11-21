import { PAYMENT_TYPES, type PaymentType, type RevgasClient, type RevgasDeal } from "../revgas/types.js";

export type PriceTable = Partial<Record<PaymentType, number>>;

export type SellableProduct = {
  productId: number;
  description: string;
  /** Empty cylinder sold with this gas when the customer has none to swap. */
  containerId: number | null;
  /** Unit price in cents per accepted payment type. A missing type cannot be used for this product. */
  pricesCents: PriceTable;
};

/** Price shown before the payment type is known: Pix, then cash, then the lowest. */
export function referencePriceCents(prices: PriceTable): number | null {
  if (prices.PIX !== undefined) return prices.PIX;
  if (prices.MONEY !== undefined) return prices.MONEY;
  const values = Object.values(prices);
  return values.length ? Math.min(...values) : null;
}

/**
 * Products the bot may sell: active, from the configured establishment, with at least one
 * general price agreement (deal of type PAYMENT_TYPE) for a payment type the bot accepts.
 * The price source lives only here.
 */
export type CatalogOptions = {
  ttlMs?: number;
  now?: () => number;
  /** REVGAS_PRODUCT_IDS: offer only these products and their cylinders. */
  productIds?: number[] | null;
  /** Payment types the bot accepts (VALEGAS only with REVGAS_VALEGAS_ENABLED). */
  acceptedPayments?: readonly PaymentType[];
};

export class Catalog {
  private cache: { at: number; items: SellableProduct[] } | null = null;
  private loading: Promise<SellableProduct[]> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly productIds: number[] | null;
  private readonly accepted: ReadonlySet<string>;

  constructor(
    private readonly client: RevgasClient,
    private readonly establishmentId: number,
    opts: CatalogOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
    this.productIds = opts.productIds ?? null;
    this.accepted = new Set(opts.acceptedPayments ?? PAYMENT_TYPES);
  }

  /**
   * Stale-while-revalidate: after the TTL the old list is returned at once and a reload runs in
   * the background (~12 pages of deals at 1 req/s). Only the very first load blocks.
   */
  async list(): Promise<SellableProduct[]> {
    if (!this.cache) return this.reload();
    if (this.now() - this.cache.at >= this.ttlMs && !this.loading) {
      this.reload().catch((e: unknown) =>
        console.error("[catálogo] recarga de produtos/acordos falhou; mantendo o cache anterior:", e instanceof Error ? e.message : e),
      );
    }
    return this.cache.items;
  }

  private reload(): Promise<SellableProduct[]> {
    // Concurrent callers share one load.
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async get(productId: number): Promise<SellableProduct | null> {
    return (await this.list()).find((p) => p.productId === productId) ?? null;
  }

  private async load(): Promise<SellableProduct[]> {
    const [products, deals] = await Promise.all([
      this.client.listProducts(this.establishmentId),
      this.client.listDeals(this.establishmentId),
    ]);
    const prices = priceIndex(deals, this.accepted);
    let allowed: Set<number> | null = null;
    if (this.productIds) {
      allowed = new Set(this.productIds);
      for (const p of products) if (this.productIds.includes(p.id) && p.container_id) allowed.add(p.container_id);
    }
    const items: SellableProduct[] = [];
    for (const p of products) {
      if (p.inactive || p.establishment_id !== this.establishmentId) continue;
      if (allowed && !allowed.has(p.id)) continue;
      const table = prices.get(p.id);
      if (!table || Object.keys(table).length === 0) continue;
      items.push({ productId: p.id, description: p.description, containerId: p.container_id ?? null, pricesCents: table });
    }
    this.cache = { at: this.now(), items };
    return items;
  }
}

function priceIndex(deals: RevgasDeal[], accepted: ReadonlySet<string>): Map<number, PriceTable> {
  const chosen = new Map<string, RevgasDeal>();
  for (const d of deals) {
    if (d.type !== "PAYMENT_TYPE" || !accepted.has(d.payment_type)) continue;
    if (!Number.isFinite(d.suggested_value) || d.suggested_value <= 0) continue;
    const key = `${d.product_id}:${d.payment_type}`;
    const current = chosen.get(key);
    if (!current || (d.is_default && !current.is_default)) chosen.set(key, d);
  }
  const index = new Map<number, PriceTable>();
  for (const d of chosen.values()) {
    const table = index.get(d.product_id) ?? {};
    table[d.payment_type as PaymentType] = Math.round(d.suggested_value * 100);
    index.set(d.product_id, table);
  }
  return index;
}
