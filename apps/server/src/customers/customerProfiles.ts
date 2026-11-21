import { eq, sql } from "drizzle-orm";
import type { PricingCustomer } from "../catalog/catalog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { customerProfiles } from "../db/schema.js";
import type { DraftData } from "../orders/draft.js";

export type CustomerProfile = typeof customerProfiles.$inferSelect;

export async function getProfile(db: Db, phone: string): Promise<CustomerProfile | null> {
  const [row] = await db.select().from(customerProfiles).where(eq(customerProfiles.phone, phone));
  return row ?? null;
}

export function hasAddress(p: CustomerProfile | null): p is CustomerProfile & { location: string; number: string } {
  return !!p?.location && !!p.number && !!p.neighborhood && !!p.city && !!p.state;
}

/** Called only after RevGás created the sale: the address of that sale becomes the saved one. */
export async function saveProfileFromSale(db: Db, phone: string, draft: DraftData, saleId: number): Promise<void> {
  const a = draft.address;
  const values = {
    location: a.location,
    number: a.number,
    neighborhood: a.neighborhood,
    city: a.city,
    state: a.state,
    complement: a.complement ?? null,
    landmark: a.landmark ?? null,
    lastSaleId: saleId,
    updatedAt: new Date(),
    ...(draft.emptyCylinders !== undefined ? { emptyCylinders: draft.emptyCylinders } : {}),
    ...(draft.customerId !== null ? { revgasCustomerId: draft.customerId } : {}),
  };
  await db
    .insert(customerProfiles)
    .values({ phone, name: draft.customerName ?? null, ...values })
    .onConflictDoUpdate({
      target: customerProfiles.phone,
      // Keep a known name when this order did not bring one.
      set: { ...values, name: sql`coalesce(${draft.customerName ?? null}, ${customerProfiles.name})` },
    });
}

export async function setRevgasCustomerId(
  db: Db,
  phone: string,
  revgasCustomerId: number,
  revgasTagId: number | null = null,
): Promise<void> {
  await db
    .insert(customerProfiles)
    .values({ phone, revgasCustomerId, revgasTagId })
    .onConflictDoUpdate({ target: customerProfiles.phone, set: { revgasCustomerId, revgasTagId, updatedAt: new Date() } });
}

/**
 * The customer to price by (REVGAS_PRICE_PRIORITY), or null for general prices. Only a customer
 * identified in RevGás has one, which needs REVGAS_CUSTOMERS_ENABLED.
 */
export async function pricingCustomer(
  db: Db,
  cfg: Pick<AppConfig, "revgasPricePriority" | "revgasCustomersEnabled">,
  customerId: number | null,
): Promise<PricingCustomer | null> {
  if (!cfg.revgasPricePriority || !cfg.revgasCustomersEnabled || customerId === null) return null;
  const [row] = await db
    .select({ tagId: customerProfiles.revgasTagId })
    .from(customerProfiles)
    .where(eq(customerProfiles.revgasCustomerId, customerId))
    .limit(1);
  return { customerId, tagId: row?.tagId ?? null };
}
