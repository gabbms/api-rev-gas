import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../../src/db/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../../.env"), quiet: true });

export const migrationsFolder = path.resolve(here, "../../drizzle");

/** Connects to DATABASE_URL_TEST, applies migrations and empties every table. */
export async function setupTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST não definida no .env");
  const handle = createDb(url);
  await migrate(handle.db, { migrationsFolder });
  return handle;
}

export async function resetTables(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE order_drafts, llm_turns, messages, handoffs, conversations, customer_profiles, simulated_sales, inbound_events RESTART IDENTITY CASCADE`);
}
