import type { RevgasClient } from "../revgas/types.js";

export type SellableProduct = { productId: number; description: string; priceCents: number };

/**
 * Products the bot may sell: active, from the configured establishment, and with a
 * price in the local table (RevGás products carry no price). Swapping the price
 * source later only touches this module.
 */
export class Catalog {
  private cache: { at: number; items: SellableProduct[] } | null = null;

  constructor(
    private readonly client: RevgasClient,
    private readonly establishmentId: number,
    private readonly prices: Record<string, number>,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<SellableProduct[]> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.items;
    const products = await this.client.listProducts(this.establishmentId);
    const items: SellableProduct[] = [];
    for (const p of products) {
      const price = this.prices[String(p.id)];
      if (p.inactive || p.establishment_id !== this.establishmentId) continue;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
      items.push({ productId: p.id, description: p.description, priceCents: Math.round(price * 100) });
    }
    this.cache = { at: this.now(), items };
    return items;
  }

  async get(productId: number): Promise<SellableProduct | null> {
    return (await this.list()).find((p) => p.productId === productId) ?? null;
  }
}
