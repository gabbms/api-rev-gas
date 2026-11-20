import { normalizePhone } from "./phone.js";
import {
  RevgasError,
  type RevgasClient,
  type RevgasCustomer,
  type RevgasDeal,
  type RevgasProduct,
  type RevgasSale,
  type SalePayload,
} from "./types.js";

/** In-memory RevGás used by tests and, with writes disabled, to simulate sales. */
export class FakeRevgasClient implements RevgasClient {
  customers: (RevgasCustomer & { phone?: string })[] = [];
  products: RevgasProduct[] = [];
  /** Deals of every establishment; listDeals returns all of them (tests add only what they need). */
  deals: RevgasDeal[] = [];
  sales: (SalePayload & { id: number })[] = [];
  failNextCreateWith?: RevgasError;
  private nextId = 900_000_001;

  async findCustomersByPhone(phone: string): Promise<RevgasCustomer[]> {
    const wanted = normalizePhone(phone);
    if (!wanted) throw new RevgasError("invalid", "Telefone inválido", 422);
    return this.customers
      .filter((c) => c.phone !== undefined && normalizePhone(c.phone) === wanted)
      .map(({ phone: _phone, ...c }) => c);
  }

  async listProducts(establishmentId: number): Promise<RevgasProduct[]> {
    return this.products.filter((p) => p.establishment_id === establishmentId);
  }

  async listDeals(_establishmentId: number): Promise<RevgasDeal[]> {
    return this.deals;
  }

  async createSale(payload: SalePayload): Promise<RevgasSale> {
    if (this.failNextCreateWith) {
      const err = this.failNextCreateWith;
      this.failNextCreateWith = undefined;
      throw err;
    }
    const id = this.nextId++;
    this.sales.push({ ...payload, id });
    return this.toSale(id);
  }

  async getSale(id: number): Promise<RevgasSale> {
    if (!this.sales.some((s) => s.id === id)) throw new RevgasError("invalid", "Venda não encontrada", 404);
    return this.toSale(id);
  }

  hasSale(id: number): boolean {
    return this.sales.some((s) => s.id === id);
  }

  private toSale(id: number): RevgasSale {
    const s = this.sales.find((x) => x.id === id)!;
    const total = Math.round(s.products.reduce((sum, p) => sum + p.quantity * p.value, 0) * 100) / 100;
    return { id, status: "OPEN", total };
  }
}
