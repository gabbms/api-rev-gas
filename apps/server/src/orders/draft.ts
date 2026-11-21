import type { SellableProduct } from "../catalog/catalog.js";
import type { PaymentType, SalePayload } from "../revgas/types.js";

export type DraftAddress = {
  location: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  complement?: string;
  landmark?: string;
};

export type DraftInput = {
  items: { productId: number; quantity: number }[];
  address: DraftAddress;
  payments: { type: PaymentType; amountCents?: number }[];
  observation?: string;
  /** Customer has an empty cylinder to swap. `false` adds the container product; unknown blocks gas orders. */
  hasEmptyCylinder?: boolean;
  /** Kept in the local customer profile after a created sale. */
  customerName?: string;
};

export type DraftLine = { productId: number; description: string; quantity: number; unitCents: number; totalCents: number };

export type DraftData = DraftInput & { lines: DraftLine[]; totalCents: number; customerId: number | null };

export type DraftResult = { ok: true; data: DraftData; summaryText: string } | { ok: false; errors: string[] };

export const PAYMENT_LABELS: Record<PaymentType, string> = {
  PIX: "Pix",
  MONEY: "Dinheiro",
  CARTAO_DE_CREDITO: "Cartão de crédito",
  CARTAO_DE_DEBITO: "Cartão de débito",
};

const ADDRESS_FIELDS: [keyof DraftAddress, string][] = [
  ["location", "rua"],
  ["number", "número"],
  ["neighborhood", "bairro"],
  ["city", "cidade"],
  ["state", "estado"],
];

export function formatCents(cents: number): string {
  const reais = Math.floor(Math.abs(cents) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}R$ ${reais},${centavos}`;
}

const clean = (s: string | undefined) => (s ?? "").trim();

/**
 * Pure validation + pricing + official summary. Prices come only from `products` and depend on
 * the payment type (deals), so lines are priced only once payments are known.
 */
export function buildDraft(
  input: DraftInput,
  products: SellableProduct[],
  customerId: number | null,
  maxQty: number,
): DraftResult {
  const errors: string[] = [];
  const find = (id: number) => products.find((p) => p.productId === id);

  // Merge repeated products, keeping first-seen order.
  const merged = new Map<number, number>();
  for (const item of input.items) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  if (merged.size === 0) errors.push("Pedido sem itens");

  // C3: gas needs an empty cylinder to swap; without one, the container product is sold too.
  const gas = [...merged].flatMap(([id, qty]) => {
    const p = find(id);
    return p?.containerId ? [{ product: p, containerId: p.containerId, qty }] : [];
  });
  if (gas.length > 0 && input.hasEmptyCylinder === undefined) {
    errors.push("Pergunte ao cliente se ele tem botijão vazio para trocar e informe hasEmptyCylinder");
  } else if (input.hasEmptyCylinder === false) {
    const needed = new Map<number, number>();
    for (const g of gas) {
      if (!find(g.containerId)) {
        errors.push(`Vasilhame do ${g.product.description} não disponível`);
        continue;
      }
      needed.set(g.containerId, (needed.get(g.containerId) ?? 0) + g.qty);
    }
    for (const [cid, qty] of needed) merged.set(cid, Math.max(merged.get(cid) ?? 0, qty));
  }

  const paymentTypes = [...new Set(input.payments.map((p) => p.type))];
  const lines: DraftLine[] = [];
  for (const [productId, quantity] of merged) {
    const product = find(productId);
    if (!product) {
      errors.push(`Produto ${productId} não disponível`);
      continue;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQty) {
      errors.push(`Quantidade inválida para ${product.description}: deve ser um número inteiro entre 1 e ${maxQty}`);
      continue;
    }
    if (paymentTypes.length === 0) continue; // reported by fillPayments
    const unavailable = paymentTypes.filter((t) => product.pricesCents[t] === undefined);
    if (unavailable.length > 0) {
      errors.push(`${product.description} não pode ser pago com ${unavailable.map((t) => PAYMENT_LABELS[t]).join(", ")}`);
      continue;
    }
    const prices = new Set(paymentTypes.map((t) => product.pricesCents[t]!));
    if (prices.size > 1) {
      errors.push(`O preço de ${product.description} muda conforme a forma de pagamento; use uma só forma de pagamento`);
      continue;
    }
    const unitCents = [...prices][0]!;
    lines.push({ productId, description: product.description, quantity, unitCents, totalCents: unitCents * quantity });
  }

  const address: DraftAddress = {
    location: clean(input.address.location),
    number: clean(input.address.number),
    neighborhood: clean(input.address.neighborhood),
    city: clean(input.address.city),
    state: clean(input.address.state),
  };
  if (clean(input.address.complement)) address.complement = clean(input.address.complement);
  if (clean(input.address.landmark)) address.landmark = clean(input.address.landmark);
  const missing = ADDRESS_FIELDS.filter(([key]) => !address[key]).map(([, label]) => label);
  if (missing.length > 0) errors.push(`Endereço incompleto: falta ${missing.join(", ")}`);

  const totalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const payments = fillPayments(input.payments, totalCents, errors);

  if (errors.length > 0) return { ok: false, errors };

  const observation = clean(input.observation);
  const customerName = clean(input.customerName);
  const data: DraftData = {
    items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    address,
    payments,
    ...(observation ? { observation } : {}),
    ...(customerName ? { customerName } : {}),
    ...(input.hasEmptyCylinder !== undefined ? { hasEmptyCylinder: input.hasEmptyCylinder } : {}),
    lines,
    totalCents,
    customerId,
  };
  return { ok: true, data, summaryText: summarize(data) };
}

function fillPayments(
  raw: DraftInput["payments"],
  totalCents: number,
  errors: string[],
): { type: PaymentType; amountCents: number }[] {
  if (raw.length === 0) {
    errors.push("Forma de pagamento não informada");
    return [];
  }
  const withoutAmount = raw.filter((p) => p.amountCents === undefined);
  if (withoutAmount.length > 1) {
    errors.push("Informe o valor de cada forma de pagamento");
    return [];
  }
  if (raw.some((p) => p.amountCents !== undefined && (!Number.isInteger(p.amountCents) || p.amountCents <= 0))) {
    errors.push("Valor de pagamento inválido");
    return [];
  }
  const known = raw.reduce((sum, p) => sum + (p.amountCents ?? 0), 0);
  // The single payment without an amount takes the remainder (the whole total if it is the only one).
  const payments = raw.map((p) => ({ type: p.type, amountCents: p.amountCents ?? totalCents - known }));
  const sum = payments.reduce((s, p) => s + p.amountCents, 0);
  if (sum !== totalCents || payments.some((p) => p.amountCents <= 0)) {
    if (totalCents > 0) errors.push("Pagamentos não somam o total");
  }
  return payments;
}

function summarize(d: DraftData): string {
  const a = d.address;
  const extras = [a.complement, a.landmark ? `ref.: ${a.landmark}` : undefined].filter(Boolean);
  const street = `${a.location}, ${a.number}${extras.length ? ` (${extras.join("; ")})` : ""}`;
  const payment =
    d.payments.length === 1
      ? PAYMENT_LABELS[d.payments[0]!.type]
      : d.payments.map((p) => `${PAYMENT_LABELS[p.type]} ${formatCents(p.amountCents!)}`).join(" + ");
  return [
    "Resumo do pedido:",
    ...d.lines.map((l) => `• ${l.quantity}x ${l.description} — ${formatCents(l.totalCents)}`),
    `Total: ${formatCents(d.totalCents)}`,
    `Pagamento: ${payment}`,
    `Entrega: ${street} – ${a.neighborhood}, ${a.city}/${a.state}`,
    ...(d.observation ? [`Obs.: ${d.observation}`] : []),
    "Posso registrar o pedido? Responda *sim* para confirmar ou me diga o que mudar.",
  ].join("\n");
}

const toReais = (cents: number) => Math.round(cents) / 100;

export function toSalePayload(d: DraftData, establishmentId: number, broadcast: "NONE" | "NEW_SALE"): SalePayload {
  const a = d.address;
  return {
    location: a.location,
    number: a.number,
    neighborhood: a.neighborhood,
    city: a.city,
    state_federation: a.state,
    ...(a.complement ? { complement: a.complement } : {}),
    ...(a.landmark ? { landmark: a.landmark } : {}),
    ...(d.observation ? { observation: d.observation } : {}),
    ...(d.customerId !== null ? { customer_id: d.customerId } : {}),
    establishment_id: establishmentId,
    products: d.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity, value: toReais(l.unitCents) })),
    payments: d.payments.map((p) => ({ payment_type: p.type, value: toReais(p.amountCents ?? 0) })),
    channel: "WHATSAPP",
    origin: "INTEGRATION",
    option: "NORMAL",
    broadcast,
  };
}
