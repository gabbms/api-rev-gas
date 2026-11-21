import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { simulatedSales } from "../db/schema.js";
import type { RevgasSale, SalePayload } from "./types.js";

/** Stores sales simulated while writes to RevGás are disabled. */
export class SimulatedSales {
  constructor(private readonly db: Db) {}

  async create(payload: SalePayload): Promise<RevgasSale> {
    const totalCents = payload.products.reduce((sum, p) => sum + Math.round(p.value * 100) * p.quantity, 0);
    const [row] = await this.db.insert(simulatedSales).values({ payload, totalCents }).returning();
    return toSale(row!);
  }

  /** The simulated sale with this id, or null when it is not one of ours. */
  async find(id: number): Promise<RevgasSale | null> {
    const [row] = await this.db.select().from(simulatedSales).where(eq(simulatedSales.id, id));
    return row ? toSale(row) : null;
  }
}

function toSale(row: typeof simulatedSales.$inferSelect): RevgasSale {
  return { id: row.id, status: row.status, total: row.totalCents / 100 };
}
