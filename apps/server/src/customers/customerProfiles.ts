import { eq, sql } from "drizzle-orm";
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

export async function setRevgasCustomerId(db: Db, phone: string, revgasCustomerId: number): Promise<void> {
  await db
    .insert(customerProfiles)
    .values({ phone, revgasCustomerId })
    .onConflictDoUpdate({ target: customerProfiles.phone, set: { revgasCustomerId, updatedAt: new Date() } });
}
