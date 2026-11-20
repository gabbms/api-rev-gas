import { describe, expect, it } from "vitest";
import type { SellableProduct } from "../../src/catalog/catalog.js";
import { buildDraft, formatCents, toSalePayload, type DraftInput } from "../../src/orders/draft.js";

const products: SellableProduct[] = [
  { productId: 23740, description: "GLP 13KG", priceCents: 11000 },
  { productId: 26255, description: "AGUA 20L", priceCents: 1200 },
];

const address = { location: "Rua das Flores", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" };

const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  items: [{ productId: 23740, quantity: 1 }],
  address,
  payments: [{ type: "PIX" }],
  ...over,
});

function ok(result: ReturnType<typeof buildDraft>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join("; ")}`);
  return result;
}

function errors(result: ReturnType<typeof buildDraft>) {
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("buildDraft", () => {
  it("produces the exact summary text for one item", () => {
    const r = ok(buildDraft(input(), products, null, 10));
    expect(r.summaryText).toBe(
      [
        "Resumo do pedido:",
        "• 1x GLP 13KG — R$ 110,00",
        "Total: R$ 110,00",
        "Pagamento: Pix",
        "Entrega: Rua das Flores, 120 – Centro, Teresina/PI",
        "Posso registrar o pedido? Responda *sim* para confirmar ou me diga o que mudar.",
      ].join("\n"),
    );
  });

  it("totals 22000 cents for 2x of 11000", () => {
    const r = ok(buildDraft(input({ items: [{ productId: 23740, quantity: 2 }] }), products, 7, 10));
    expect(r.data.totalCents).toBe(22000);
    expect(r.data.lines).toEqual([
      { productId: 23740, description: "GLP 13KG", quantity: 2, unitCents: 11000, totalCents: 22000 },
    ]);
    expect(r.data.customerId).toBe(7);
    expect(r.data.payments).toEqual([{ type: "PIX", amountCents: 22000 }]);
  });

  it("rejects an unknown product", () => {
    expect(errors(buildDraft(input({ items: [{ productId: 999, quantity: 1 }] }), products, null, 10))).toContain(
      "Produto 999 não disponível",
    );
  });

  it.each([0, 11, 1.5, -1])("rejects quantity %d", (quantity) => {
    expect(errors(buildDraft(input({ items: [{ productId: 23740, quantity }] }), products, null, 10))).toHaveLength(1);
  });

  it("rejects an order with no items", () => {
    expect(errors(buildDraft(input({ items: [] }), products, null, 10))).toHaveLength(1);
  });

  it("rejects an address without number", () => {
    const errs = errors(buildDraft(input({ address: { ...address, number: "  " } }), products, null, 10));
    expect(errs.join(" ")).toMatch(/número/);
  });

  it("accepts MONEY 5000 + PIX 6000 for a total of 11000", () => {
    const r = ok(
      buildDraft(
        input({ payments: [{ type: "MONEY", amountCents: 5000 }, { type: "PIX", amountCents: 6000 }] }),
        products,
        null,
        10,
      ),
    );
    expect(r.summaryText).toContain("Pagamento: Dinheiro R$ 50,00 + Pix R$ 60,00");
  });

  it("rejects payments that do not add up to the total", () => {
    expect(
      errors(
        buildDraft(input({ payments: [{ type: "MONEY", amountCents: 5000 }, { type: "PIX", amountCents: 5000 }] }), products, null, 10),
      ),
    ).toContain("Pagamentos não somam o total");
  });

  it("rejects an order with no payment", () => {
    expect(errors(buildDraft(input({ payments: [] }), products, null, 10))).toHaveLength(1);
  });

  it("merges repeated items of the same product into one line", () => {
    const r = ok(
      buildDraft(
        input({ items: [{ productId: 23740, quantity: 1 }, { productId: 26255, quantity: 1 }, { productId: 23740, quantity: 2 }] }),
        products,
        null,
        10,
      ),
    );
    expect(r.data.lines.map((l) => [l.productId, l.quantity])).toEqual([
      [23740, 3],
      [26255, 1],
    ]);
    expect(r.data.items).toEqual([
      { productId: 23740, quantity: 3 },
      { productId: 26255, quantity: 1 },
    ]);
  });

  it("checks the merged quantity against the maximum", () => {
    const items = [{ productId: 23740, quantity: 6 }, { productId: 23740, quantity: 5 }];
    expect(errors(buildDraft(input({ items }), products, null, 10))).toHaveLength(1);
  });

  it("shows complement, landmark and observation", () => {
    const r = ok(
      buildDraft(
        input({ address: { ...address, complement: "Apto 2", landmark: "perto da praça" }, observation: "Troco para 200" }),
        products,
        null,
        10,
      ),
    );
    expect(r.summaryText).toContain("Entrega: Rua das Flores, 120 (Apto 2; ref.: perto da praça) – Centro, Teresina/PI");
    expect(r.summaryText).toContain("\nObs.: Troco para 200\n");
  });
});

describe("formatCents", () => {
  it.each([
    [11000, "R$ 110,00"],
    [5, "R$ 0,05"],
    [123456789, "R$ 1.234.567,89"],
  ])("formats %i as %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

describe("toSalePayload", () => {
  it("converts to reais, sets fixed fields and omits empty optionals", () => {
    const r = ok(buildDraft(input({ items: [{ productId: 23740, quantity: 2 }] }), products, null, 10));
    const p = toSalePayload(r.data, 2580, "NONE");
    expect(p).toEqual({
      location: "Rua das Flores",
      number: "120",
      neighborhood: "Centro",
      city: "Teresina",
      state_federation: "PI",
      establishment_id: 2580,
      products: [{ product_id: 23740, quantity: 2, value: 110 }],
      payments: [{ payment_type: "PIX", value: 220 }],
      channel: "WHATSAPP",
      origin: "INTEGRATION",
      option: "NORMAL",
      broadcast: "NONE",
    });
    expect(p).not.toHaveProperty("customer_id");
    expect(p).not.toHaveProperty("deliverer_id");
  });

  it("includes customer_id, complement, landmark and observation when present", () => {
    const r = ok(
      buildDraft(
        input({ address: { ...address, complement: "Apto 2", landmark: "praça" }, observation: "Troco para 200" }),
        products,
        42,
        10,
      ),
    );
    const p = toSalePayload(r.data, 2580, "NEW_SALE");
    expect(p).toMatchObject({ customer_id: 42, complement: "Apto 2", landmark: "praça", observation: "Troco para 200", broadcast: "NEW_SALE" });
  });

  it("keeps cents exact when converting to reais", () => {
    const r = ok(buildDraft(input(), [{ productId: 23740, description: "X", priceCents: 10990 }], null, 10));
    expect(toSalePayload(r.data, 2580, "NONE").products[0]?.value).toBe(109.9);
  });
});
