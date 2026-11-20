import { z } from "zod";

export const PAYMENT_TYPES = ["PIX", "MONEY", "CARTAO_DE_CREDITO", "CARTAO_DE_DEBITO", "VALEGAS"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

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
});
export type RevgasCustomer = z.infer<typeof customerSchema>;

export const productSchema = z.object({
  id: z.number(),
  description: z.string(),
  inactive: z.boolean(),
  establishment_id: z.number(),
});
export type RevgasProduct = z.infer<typeof productSchema>;

export const saleSchema = z.object({
  id: z.number(),
  status: z.enum(SALE_STATUSES),
  total: z.number(),
});
export type RevgasSale = z.infer<typeof saleSchema>;

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
  payments: { payment_type: PaymentType; value: number }[];
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
  createSale(payload: SalePayload): Promise<RevgasSale>;
  getSale(id: number): Promise<RevgasSale>;
}
