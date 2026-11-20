import { beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../../src/catalog/catalog.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";

let fake: FakeRevgasClient;
let t: number;
const now = () => t;

beforeEach(() => {
  t = 0;
  fake = new FakeRevgasClient();
  fake.products.push(
    { id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580 },
    { id: 2, description: "Sem preço", inactive: false, establishment_id: 2580 },
    { id: 3, description: "Inativo", inactive: true, establishment_id: 2580 },
    { id: 4, description: "Outra loja", inactive: false, establishment_id: 2601 },
  );
});

const prices = { "23740": 110, "3": 50, "4": 70 };

describe("Catalog", () => {
  it("lists only active products of the establishment that have a price", async () => {
    const catalog = new Catalog(fake, 2580, prices, 1000, now);
    expect(await catalog.list()).toEqual([{ productId: 23740, description: "GLP 13KG", priceCents: 11000 }]);
  });

  it("gets a sellable product by id, or null", async () => {
    const catalog = new Catalog(fake, 2580, prices, 1000, now);
    expect(await catalog.get(23740)).toMatchObject({ priceCents: 11000 });
    expect(await catalog.get(2)).toBeNull();
    expect(await catalog.get(3)).toBeNull();
  });

  it("caches the product list within the TTL and refreshes after it", async () => {
    const spy = vi.spyOn(fake, "listProducts");
    const catalog = new Catalog(fake, 2580, prices, 1000, now);
    await catalog.list();
    t = 999;
    await catalog.list();
    expect(spy).toHaveBeenCalledTimes(1);
    t = 1000;
    await catalog.list();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("converts fractional prices to whole cents", async () => {
    const catalog = new Catalog(fake, 2580, { "23740": 109.9 }, 1000, now);
    expect((await catalog.get(23740))?.priceCents).toBe(10990);
  });
});
