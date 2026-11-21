import { describe, expect, it } from "vitest";
import type { SellableProduct } from "../../src/catalog/catalog.js";
import { buildDraft, formatCents, toSalePayload, type DraftInput } from "../../src/orders/draft.js";

const GAS = 23740;
const CYLINDER = 23741;
const GAS45 = 23974;
const CYLINDER45 = 23975;
const WATER = 26255;

const products: SellableProduct[] = [
  { productId: GAS, description: "GLP 13KG", containerId: CYLINDER, pricesCents: { PIX: 11000, MONEY: 11000, CARTAO_DE_CREDITO: 11500 } },
  { productId: CYLINDER, description: "VASILHAME 13KG", containerId: null, pricesCents: { PIX: 1000, MONEY: 1000, CARTAO_DE_CREDITO: 1000 } },
  { productId: GAS45, description: "GLP 45KG", containerId: CYLINDER45, pricesCents: { PIX: 40000 } },
  { productId: CYLINDER45, description: "VASILHAME 45KG", containerId: null, pricesCents: { PIX: 30000 } },
  { productId: WATER, description: "AGUA 20L", containerId: null, pricesCents: { PIX: 1200, MONEY: 1200 } },
];

const address = { location: "Rua das Flores", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" };

const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  items: [{ productId: GAS, quantity: 1 }],
  address,
  payments: [{ type: "PIX" }],
  emptyCylinders: 10, // enough to swap every gas unless a test says otherwise
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
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }] }), products, 7, 10));
    expect(r.data.totalCents).toBe(22000);
    expect(r.data.lines).toEqual([{ productId: GAS, description: "GLP 13KG", quantity: 2, unitCents: 11000, totalCents: 22000 }]);
    expect(r.data.customerId).toBe(7);
    expect(r.data.payments).toEqual([{ type: "PIX", amountCents: 22000 }]);
  });

  it("rejects an unknown product", () => {
    expect(errors(buildDraft(input({ items: [{ productId: 999, quantity: 1 }] }), products, null, 10))).toContain(
      "Produto 999 não disponível",
    );
  });

  it.each([0, 11, 1.5, -1])("rejects quantity %d", (quantity) => {
    expect(errors(buildDraft(input({ items: [{ productId: GAS, quantity }] }), products, null, 10))).toHaveLength(1);
  });

  it("rejects an order with no items", () => {
    expect(errors(buildDraft(input({ items: [] }), products, null, 10))).toHaveLength(1);
  });

  it("C8: still requires the full address (number missing)", () => {
    const errs = errors(buildDraft(input({ address: { ...address, number: "  " } }), products, null, 10));
    expect(errs.join(" ")).toMatch(/número/);
  });

  it("accepts MONEY 5000 + PIX 6000 for a total of 11000", () => {
    const r = ok(
      buildDraft(input({ payments: [{ type: "MONEY", amountCents: 5000 }, { type: "PIX", amountCents: 6000 }] }), products, null, 10),
    );
    expect(r.summaryText).toContain("Pagamento: Dinheiro R$ 50,00 + Pix R$ 60,00");
  });

  it("rejects payments that do not add up to the total", () => {
    expect(
      errors(buildDraft(input({ payments: [{ type: "MONEY", amountCents: 5000 }, { type: "PIX", amountCents: 5000 }] }), products, null, 10)),
    ).toContain("Pagamentos não somam o total");
  });

  it("rejects an order with no payment, without price errors", () => {
    expect(errors(buildDraft(input({ payments: [] }), products, null, 10))).toEqual(["Forma de pagamento não informada"]);
  });

  it("merges repeated items of the same product into one line", () => {
    const r = ok(
      buildDraft(
        input({ items: [{ productId: GAS, quantity: 1 }, { productId: WATER, quantity: 1 }, { productId: GAS, quantity: 2 }] }),
        products,
        null,
        10,
      ),
    );
    expect(r.data.lines.map((l) => [l.productId, l.quantity])).toEqual([
      [GAS, 3],
      [WATER, 1],
    ]);
  });

  it("checks the merged quantity against the maximum", () => {
    const items = [{ productId: GAS, quantity: 6 }, { productId: GAS, quantity: 5 }];
    expect(errors(buildDraft(input({ items }), products, null, 10))).toHaveLength(1);
  });

  it("shows complement, landmark and observation", () => {
    const r = ok(
      buildDraft(input({ address: { ...address, complement: "Apto 2", landmark: "perto da praça" }, observation: "Troco para 200" }), products, null, 10),
    );
    expect(r.summaryText).toContain("Entrega: Rua das Flores, 120 (Apto 2; ref.: perto da praça) – Centro, Teresina/PI");
    expect(r.summaryText).toContain("\nObs.: Troco para 200\n");
  });

  it("keeps the customer name and cylinder answer in the draft data", () => {
    const r = ok(buildDraft(input({ customerName: "  Maria  " }), products, null, 10));
    expect(r.data).toMatchObject({ customerName: "Maria", emptyCylinders: 10 });
  });
});

describe("buildDraft — C2: price depends on the payment type", () => {
  it("uses the price of the chosen payment type", () => {
    const r = ok(buildDraft(input({ payments: [{ type: "CARTAO_DE_CREDITO" }] }), products, null, 10));
    expect(r.data.lines[0]).toMatchObject({ unitCents: 11500, totalCents: 11500 });
    expect(r.summaryText).toContain("• 1x GLP 13KG — R$ 115,00");
  });

  it("rejects a payment type without a deal for the product", () => {
    expect(errors(buildDraft(input({ payments: [{ type: "CARTAO_DE_DEBITO" }] }), products, null, 10))).toEqual([
      "GLP 13KG não pode ser pago com Cartão de débito",
    ]);
  });

  it("rejects split payments whose types price the product differently", () => {
    const errs = errors(
      buildDraft(input({ payments: [{ type: "PIX", amountCents: 5000 }, { type: "CARTAO_DE_CREDITO", amountCents: 6000 }] }), products, null, 10),
    );
    expect(errs.join(" ")).toMatch(/GLP 13KG.*muda conforme a forma de pagamento/);
  });
});

describe("buildDraft — C3: empty cylinder", () => {
  it("asks whether the customer has an empty cylinder when it is not known", () => {
    expect(errors(buildDraft(input({ emptyCylinders: undefined }), products, null, 10)).join(" ")).toMatch(/botijões vazios/);
  });

  it("does not ask for products without a container", () => {
    ok(buildDraft(input({ items: [{ productId: WATER, quantity: 1 }], emptyCylinders: undefined }), products, null, 10));
  });

  it("adds the cylinder line, priced by the same payment type, when there is none to swap", () => {
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }], emptyCylinders: 0 }), products, null, 10));
    expect(r.data.lines.map((l) => [l.productId, l.quantity, l.unitCents])).toEqual([
      [GAS, 2, 11000],
      [CYLINDER, 2, 1000],
    ]);
    expect(r.data.totalCents).toBe(24000);
    expect(r.summaryText).toContain("• 2x GLP 13KG — R$ 220,00\n• 2x VASILHAME 13KG — R$ 20,00\nTotal: R$ 240,00");
  });

  it("does not double the cylinder when the AI already listed it", () => {
    const items = [{ productId: GAS, quantity: 1 }, { productId: CYLINDER, quantity: 1 }];
    const r = ok(buildDraft(input({ items, emptyCylinders: 0 }), products, null, 10));
    expect(r.data.lines.map((l) => [l.productId, l.quantity])).toEqual([
      [GAS, 1],
      [CYLINDER, 1],
    ]);
  });

  it("rejects the order when the cylinder is not sellable", () => {
    const noCylinder = products.filter((p) => p.productId !== CYLINDER);
    expect(errors(buildDraft(input({ emptyCylinders: 0 }), noCylinder, null, 10))).toEqual([
      "Vasilhame do GLP 13KG não disponível",
    ]);
  });

  it("partial swap: 2x GLP 13KG with 1 empty cylinder charges 1 cylinder", () => {
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }], emptyCylinders: 1 }), products, null, 10));
    expect(r.data.lines.map((l) => [l.productId, l.quantity])).toEqual([
      [GAS, 2],
      [CYLINDER, 1],
    ]);
    expect(r.summaryText).toContain("• 2x GLP 13KG — R$ 220,00\n• 1x VASILHAME 13KG — R$ 10,00\nTotal: R$ 230,00");
  });

  it("charges no cylinder when there are at least as many empties as gas", () => {
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }], emptyCylinders: 5 }), products, null, 10));
    expect(r.data.lines.map((l) => l.productId)).toEqual([GAS]);
  });

  it("does not need a sellable cylinder when every gas is swapped", () => {
    const noCylinder = products.filter((p) => p.productId !== CYLINDER);
    ok(buildDraft(input({ emptyCylinders: 1 }), noCylinder, null, 10));
  });

  it("groups cylinders by type, using the empties in item order", () => {
    const items = [{ productId: GAS, quantity: 2 }, { productId: GAS45, quantity: 1 }];
    const r = ok(buildDraft(input({ items, emptyCylinders: 1 }), products, null, 10));
    expect(r.data.lines.map((l) => [l.productId, l.quantity])).toEqual([
      [GAS, 2],
      [GAS45, 1],
      [CYLINDER, 1],
      [CYLINDER45, 1],
    ]);
  });

  it.each([-1, 1.5])("rejects emptyCylinders %d", (emptyCylinders) => {
    expect(errors(buildDraft(input({ emptyCylinders }), products, null, 10)).join(" ")).toMatch(/botijões vazios/);
  });

  it("keeps the number of empties in the draft data", () => {
    expect(ok(buildDraft(input({ emptyCylinders: 0 }), products, null, 10)).data.emptyCylinders).toBe(0);
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
  it("C4: sends the UNIT price per product (q=2, value=110, not 220), fixed fields, no empty optionals", () => {
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }] }), products, null, 10));
    const p = toSalePayload(r.data, 2580, "NONE");
    expect(p).toEqual({
      location: "Rua das Flores",
      number: "120",
      neighborhood: "Centro",
      city: "Teresina",
      state_federation: "PI",
      establishment_id: 2580,
      products: [{ product_id: GAS, quantity: 2, value: 110 }],
      payments: [{ payment_type: "PIX", value: 220 }],
      channel: "WHATSAPP",
      origin: "INTEGRATION",
      option: "NORMAL",
      broadcast: "NONE",
    });
    expect(p).not.toHaveProperty("customer_id");
    expect(p).not.toHaveProperty("deliverer_id");
  });

  it("sends the cylinder as its own product line at its unit price", () => {
    const r = ok(buildDraft(input({ items: [{ productId: GAS, quantity: 2 }], emptyCylinders: 0 }), products, null, 10));
    expect(toSalePayload(r.data, 2580, "NONE").products).toEqual([
      { product_id: GAS, quantity: 2, value: 110 },
      { product_id: CYLINDER, quantity: 2, value: 10 },
    ]);
  });

  it("includes customer_id, complement, landmark and observation when present", () => {
    const r = ok(buildDraft(input({ address: { ...address, complement: "Apto 2", landmark: "praça" }, observation: "Troco para 200" }), products, 42, 10));
    expect(toSalePayload(r.data, 2580, "NEW_SALE")).toMatchObject({
      customer_id: 42,
      complement: "Apto 2",
      landmark: "praça",
      observation: "Troco para 200",
      broadcast: "NEW_SALE",
    });
  });

  it("keeps cents exact when converting to reais", () => {
    const r = ok(buildDraft(input(), [{ productId: GAS, description: "X", containerId: null, pricesCents: { PIX: 10990 } }], null, 10));
    expect(toSalePayload(r.data, 2580, "NONE").products[0]?.value).toBe(109.9);
  });
});
