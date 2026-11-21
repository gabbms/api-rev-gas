import { PAYMENT_TYPES, type DealFilter, type PaymentType, type RevgasClient, type RevgasDeal, type RevgasProduct } from "../revgas/types.js";

export type PriceTable = Partial<Record<PaymentType, number>>;

/** Which kind of deal a price came from (REVGAS_PRICE_PRIORITY: CUSTOMER > TAG > PAYMENT_TYPE). */
export type PriceSource = "CUSTOMER" | "TAG" | "PAYMENT_TYPE";

export type SellableProduct = {
  productId: number;
  description: string;
  /** Empty cylinder sold with this gas when the customer has none to swap. */
  containerId: number | null;
  /** Unit price in cents per accepted payment type. A missing type cannot be used for this product. */
  pricesCents: PriceTable;
  /** Deal type behind each price in `pricesCents` (absent = general deal). */
  priceSources?: Partial<Record<PaymentType, PriceSource>>;
};

/** A customer identified in RevGás, for customer and category (TAG) prices. */
export type PricingCustomer = { customerId: number; tagId: number | null };

/** Price shown before the payment type is known: Pix, then cash, then the lowest. */
export function referencePriceCents(prices: PriceTable): number | null {
  if (prices.PIX !== undefined) return prices.PIX;
  if (prices.MONEY !== undefined) return prices.MONEY;
  const values = Object.values(prices);
  return values.length ? Math.min(...values) : null;
}

export type CatalogOptions = {
  ttlMs?: number;
  now?: () => number;
  /** REVGAS_PRODUCT_IDS: offer only these products and their cylinders. */
  productIds?: number[] | null;
  /** Payment types the bot accepts (VALEGAS only with REVGAS_VALEGAS_ENABLED). */
  acceptedPayments?: readonly PaymentType[];
};

type Index = Map<number, PriceTable>;
type Base = { products: RevgasProduct[]; general: Index };

/**
 * Products the bot may sell and their prices — the only place prices are decided. A product is
 * sellable when it is active, from the configured establishment and has a deal for a payment
 * type the bot accepts. For an identified customer, each (product, payment) price comes from the
 * customer's deal, else the customer category's deal, else the general deal.
 */
export class Catalog {
  private cache: { at: number; base: Base } | null = null;
  private loading: Promise<Base> | null = null;
  private readonly overlays = new Map<string, { at: number; index: Index }>();
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

  /** Without a customer: general prices. With one: customer > category > general. */
  async list(customer?: PricingCustomer | null): Promise<SellableProduct[]> {
    const base = await this.base();
    if (!customer) return build(base.products, [[base.general, "PAYMENT_TYPE"]]);
    const layers: [Index, PriceSource][] = [];
    const own = await this.overlay({ customerId: customer.customerId }, "CUSTOMER");
    if (own) layers.push([own, "CUSTOMER"]);
    if (customer.tagId !== null) {
      const tag = await this.overlay({ tagId: customer.tagId }, "TAG");
      if (tag) layers.push([tag, "TAG"]);
    }
    layers.push([base.general, "PAYMENT_TYPE"]);
    return build(base.products, layers);
  }

  async get(productId: number, customer?: PricingCustomer | null): Promise<SellableProduct | null> {
    return (await this.list(customer)).find((p) => p.productId === productId) ?? null;
  }

  /**
   * Stale-while-revalidate: after the TTL the old list is returned at once and a reload runs in
   * the background (~12 pages of deals at 1 req/s). Only the very first load blocks.
   */
  private async base(): Promise<Base> {
    if (!this.cache) return this.reload();
    if (this.now() - this.cache.at >= this.ttlMs && !this.loading) {
      this.reload().catch((e: unknown) =>
        console.error("[catálogo] recarga de produtos/acordos falhou; mantendo o cache anterior:", e instanceof Error ? e.message : e),
      );
    }
    return this.cache.base;
  }

  private reload(): Promise<Base> {
    // Concurrent callers share one load.
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<Base> {
    const [all, deals] = await Promise.all([
      this.client.listProducts(this.establishmentId),
      this.client.listDeals(this.establishmentId),
    ]);
    let allowed: Set<number> | null = null;
    if (this.productIds) {
      allowed = new Set(this.productIds);
      for (const p of all) if (this.productIds.includes(p.id) && p.container_id) allowed.add(p.container_id);
    }
    const products = all.filter(
      (p) => !p.inactive && p.establishment_id === this.establishmentId && (!allowed || allowed.has(p.id)),
    );
    const base = { products, general: priceIndex(deals, "PAYMENT_TYPE", this.accepted) };
    this.cache = { at: this.now(), base };
    return base;
  }

  /** Customer or category deals, cached per id. A failed read falls back to the general prices. */
  private async overlay(filter: DealFilter, type: "CUSTOMER" | "TAG"): Promise<Index | null> {
    const key = "customerId" in filter ? `c:${filter.customerId}` : `t:${filter.tagId}`;
    const hit = this.overlays.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.index;
    try {
      const index = priceIndex(await this.client.listDealsBy(this.establishmentId, filter), type, this.accepted);
      this.overlays.set(key, { at: this.now(), index });
      return index;
    } catch (e) {
      console.error(`[catálogo] acordos ${type} (${key}) indisponíveis; usando os preços gerais:`, e instanceof Error ? e.message : e);
      return hit?.index ?? null;
    }
  }
}

/** First layer with a price for a (product, payment) pair wins. */
function build(products: RevgasProduct[], layers: [Index, PriceSource][]): SellableProduct[] {
  const items: SellableProduct[] = [];
  for (const p of products) {
    const pricesCents: PriceTable = {};
    const priceSources: Partial<Record<PaymentType, PriceSource>> = {};
    for (const [index, source] of layers) {
      for (const [type, cents] of Object.entries(index.get(p.id) ?? {}) as [PaymentType, number][]) {
        if (pricesCents[type] !== undefined) continue;
        pricesCents[type] = cents;
        priceSources[type] = source;
      }
    }
    if (Object.keys(pricesCents).length === 0) continue;
    items.push({ productId: p.id, description: p.description, containerId: p.container_id ?? null, pricesCents, priceSources });
  }
  return items;
}

function priceIndex(deals: RevgasDeal[], type: PriceSource, accepted: ReadonlySet<string>): Index {
  const chosen = new Map<string, RevgasDeal>();
  for (const d of deals) {
    if (d.type !== type || !accepted.has(d.payment_type)) continue;
    if (!Number.isFinite(d.suggested_value) || d.suggested_value <= 0) continue;
    const key = `${d.product_id}:${d.payment_type}`;
    const current = chosen.get(key);
    if (!current || (d.is_default && !current.is_default)) chosen.set(key, d);
  }
  const index: Index = new Map();
  for (const d of chosen.values()) {
    const table = index.get(d.product_id) ?? {};
    table[d.payment_type as PaymentType] = Math.round(d.suggested_value * 100);
    index.set(d.product_id, table);
  }
  return index;
}
