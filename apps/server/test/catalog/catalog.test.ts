import { beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog, referencePriceCents } from "../../src/catalog/catalog.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import type { RevgasDeal } from "../../src/revgas/types.js";

let fake: FakeRevgasClient;
let t: number;
const now = () => t;

let nextDealId = 1;
const deal = (product_id: number, payment_type: string, suggested_value: number, over: Partial<RevgasDeal> = {}): RevgasDeal => ({
  id: nextDealId++,
  product_id,
  payment_type,
  suggested_value,
  minimum_value: null,
  type: "PAYMENT_TYPE",
  is_default: false,
  ...over,
});

beforeEach(() => {
  t = 0;
  fake = new FakeRevgasClient();
  fake.products.push(
    { id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580, container_id: 23741 },
    { id: 23741, description: "VASILHAME 13KG", inactive: false, establishment_id: 2580, container_id: null },
    { id: 2, description: "Sem acordo", inactive: false, establishment_id: 2580 },
    { id: 3, description: "Inativo", inactive: true, establishment_id: 2580 },
    { id: 4, description: "Outra loja", inactive: false, establishment_id: 2601 },
  );
  fake.deals.push(
    deal(23740, "PIX", 150),
    deal(23740, "MONEY", 150),
    deal(23740, "CARTAO_DE_CREDITO", 155),
    deal(23741, "PIX", 10),
    deal(3, "PIX", 50),
    deal(4, "PIX", 70),
  );
});

describe("Catalog (C2: prices from /deals)", () => {
  it("lists active products of the establishment that have a deal, priced per payment type", async () => {
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect(await catalog.list()).toEqual([
      { productId: 23740, description: "GLP 13KG", containerId: 23741, pricesCents: { PIX: 15000, MONEY: 15000, CARTAO_DE_CREDITO: 15500 } },
      { productId: 23741, description: "VASILHAME 13KG", containerId: null, pricesCents: { PIX: 1000 } },
    ]);
  });

  it("ignores TAG and CUSTOMER deals", async () => {
    fake.deals.push(deal(23740, "PIX", 99, { type: "TAG" }), deal(23740, "PIX", 98, { type: "CUSTOMER" }));
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect((await catalog.get(23740))?.pricesCents.PIX).toBe(15000);
  });

  it("C7: ignores payment types outside the fixed list (e.g. WALLET, FETLOCK)", async () => {
    fake.deals.push(deal(23741, "WALLET", 10), deal(23741, "FETLOCK", 285));
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect((await catalog.get(23741))?.pricesCents).toEqual({ PIX: 1000 });
  });

  it("prefers the default deal when a product has two for the same payment type", async () => {
    fake.deals.push(deal(23741, "PIX", 12, { is_default: true }), deal(23741, "PIX", 11));
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect((await catalog.get(23741))?.pricesCents.PIX).toBe(1200);
  });

  it("converts decimal reais to whole cents and drops non-positive prices", async () => {
    fake.deals.length = 0;
    fake.deals.push(deal(23740, "PIX", 149.9), deal(23740, "MONEY", 0));
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect((await catalog.get(23740))?.pricesCents).toEqual({ PIX: 14990 });
  });

  it("returns null for a product without deals", async () => {
    const catalog = new Catalog(fake, 2580, 1000, now);
    expect(await catalog.get(2)).toBeNull();
  });

  it("caches products and deals within the TTL and refreshes after it", async () => {
    const products = vi.spyOn(fake, "listProducts");
    const deals = vi.spyOn(fake, "listDeals");
    const catalog = new Catalog(fake, 2580, 1000, now);
    await catalog.list();
    t = 999;
    await catalog.list();
    expect([products.mock.calls.length, deals.mock.calls.length]).toEqual([1, 1]);
    t = 1000;
    await catalog.list();
    expect([products.mock.calls.length, deals.mock.calls.length]).toEqual([2, 2]);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const deals = vi.spyOn(fake, "listDeals");
    const catalog = new Catalog(fake, 2580, 1000, now);
    await Promise.all([catalog.list(), catalog.list(), catalog.get(23740)]);
    expect(deals).toHaveBeenCalledTimes(1);
  });
});

describe("referencePriceCents", () => {
  it("uses Pix, then cash, then the lowest price", () => {
    expect(referencePriceCents({ PIX: 100, MONEY: 90 })).toBe(100);
    expect(referencePriceCents({ MONEY: 90, CARTAO_DE_CREDITO: 95 })).toBe(90);
    expect(referencePriceCents({ CARTAO_DE_CREDITO: 95, VALEGAS: 93 })).toBe(93);
  });
});
