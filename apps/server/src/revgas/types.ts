import { z } from "zod";

/** Every payment type the bot knows. */
export const ALL_PAYMENT_TYPES = ["PIX", "MONEY", "CARTAO_DE_CREDITO", "CARTAO_DE_DEBITO", "VALEGAS"] as const;
export type PaymentType = (typeof ALL_PAYMENT_TYPES)[number];

/** Accepted by default. VALEGAS only with REVGAS_VALEGAS_ENABLED (coupon code in payments[].serial). */
export const PAYMENT_TYPES = ["PIX", "MONEY", "CARTAO_DE_CREDITO", "CARTAO_DE_DEBITO"] as const satisfies readonly PaymentType[];

export function acceptedPaymentTypes(valegasEnabled: boolean): readonly PaymentType[] {
  return valegasEnabled ? ALL_PAYMENT_TYPES : PAYMENT_TYPES;
}

export const SALE_STATUSES = ["CANCEL", "OPEN", "ACTIVE", "WARNING", "CONFIRM", "CHECK"] as const;

const nullableText = z.string().nullish().transform((v) => v ?? null);

// Schemas tolerate extra fields from the API (zod objects strip unknown keys by default).
export const customerSchema = z.object({
  id: z.number(),
  name: z.string(),
  location: nullableText,
  number: nullableText,
  neighborhood: nullableText,
  city: nullableText,
  state_federation: nullableText,
  complement: nullableText,
  landmark: nullableText,
  /** Customer category, used for TAG price deals. */
  tag_id: z.number().nullish().transform((v) => v ?? null),
});
export type RevgasCustomer = Omit<z.infer<typeof customerSchema>, "tag_id"> & { tag_id?: number | null };

export const productSchema = z.object({
  id: z.number(),
  description: z.string(),
  inactive: z.boolean(),
  establishment_id: z.number(),
  /** Empty cylinder (vasilhame) sold with this gas when the customer has none to swap. */
  container_id: z.number().nullish().transform((v) => v ?? null),
});
export type RevgasProduct = z.input<typeof productSchema> & { container_id?: number | null };

// Status: the list filter spells it WARN, responses WARNING; unknown values (e.g. RECEIVED) pass through.
export const saleSchema = z.object({
  id: z.number(),
  status: z.string().transform((s) => (s === "WARN" ? "WARNING" : s)),
  total: z.number(),
});
export type RevgasSale = { id: number; status: (typeof SALE_STATUSES)[number] | (string & {}); total: number };

const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);

/** Price agreement (acordo). Real responses send values as numbers; the spec says decimal strings. */
export const dealSchema = z.object({
  id: z.number(),
  product_id: z.number(),
  payment_type: z.string(),
  suggested_value: decimal,
  minimum_value: decimal.nullish(),
  type: z.string(),
  is_default: z.boolean().nullish().transform((v) => v ?? false),
  customer_id: z.number().nullish().transform((v) => v ?? null),
  tag_id: z.number().nullish().transform((v) => v ?? null),
});
export type RevgasDeal = Omit<z.output<typeof dealSchema>, "customer_id" | "tag_id"> & {
  customer_id?: number | null;
  tag_id?: number | null;
};

export type DealFilter = { customerId: number } | { tagId: number };

export const dealPageSchema = z.object({
  data: z.array(dealSchema),
  pagination: z.object({ has_next: z.boolean() }).optional(),
});

export const productPageSchema = z.object({
  data: z.array(productSchema),
  pagination: z.object({ has_next: z.boolean() }).optional(),
});

export type SalePayload = {
  location: string;
  number: string;
  neighborhood: string;
  city: string;
  state_federation: string;
  complement?: string;
  landmark?: string;
  observation?: string;
  customer_id?: number;
  establishment_id: number;
  products: { product_id: number; quantity: number; value: number }[];
  /** serial: Vale Gás coupon code. */
  payments: { payment_type: PaymentType; value: number; serial?: string }[];
  channel: "WHATSAPP";
  origin: "INTEGRATION";
  option: "NORMAL";
  broadcast: "NONE" | "NEW_SALE";
};

export type RevgasErrorKind =
  | "invalid"
  | "auth"
  | "rate_limited"
  | "conflict_lock"
  | "duplicate"
  | "server"
  | "network";

export class RevgasError extends Error {
  constructor(
    public readonly kind: RevgasErrorKind,
    message?: string,
    public readonly status?: number,
  ) {
    super(message ?? `Erro RevGás (${kind})`);
    this.name = "RevgasError";
  }
}

export interface RevgasClient {
  findCustomersByPhone(phone: string): Promise<RevgasCustomer[]>;
  /** Walks every page. */
  listProducts(establishmentId: number): Promise<RevgasProduct[]>;
  /** Deals without customer or tag (general price per payment type), every page. */
  listDeals(establishmentId: number): Promise<RevgasDeal[]>;
  /** Deals of one customer (CUSTOMER) or one customer category (TAG), every page. */
  listDealsBy(establishmentId: number, filter: DealFilter): Promise<RevgasDeal[]>;
  createSale(payload: SalePayload): Promise<RevgasSale>;
  getSale(id: number): Promise<RevgasSale>;
}
