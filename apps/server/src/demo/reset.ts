import type { Db } from "../db/client.js";
import { conversations, customerProfiles, handoffs, llmTurns, messages, orderDrafts, simulatedSales } from "../db/schema.js";

export const CONFIRMATION = "APAGAR";

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

/** Why the demo reset must not run, or null when it may. Never touches RevGás nor the test database. */
export function checkResetAllowed(
  env: { databaseUrl: string; databaseUrlTest?: string; writeEnabled: boolean },
  typed: string,
): string | null {
  if (env.writeEnabled) {
    return "Recusado: REVGAS_WRITE_ENABLED=true. Com vendas reais ligadas, os rascunhos e as vendas não podem ser apagados.";
  }
  const name = databaseName(env.databaseUrl);
  const testName = env.databaseUrlTest ? databaseName(env.databaseUrlTest) : null;
  if (name === testName || name.endsWith("_test")) {
    return "Recusado: DATABASE_URL aponta para o banco de teste. Este comando só limpa o banco de desenvolvimento.";
  }
  if (typed !== CONFIRMATION) return `Cancelado: era preciso digitar ${CONFIRMATION}.`;
  return null;
}

/**
 * Deletes every conversation and what hangs off it. The simulated-sale id sequence is kept, so a
 * sale number already shown never comes back.
 */
export async function wipeDemoData(db: Db) {
  return db.transaction(async (tx) => {
    const n = async (table: Parameters<typeof tx.delete>[0]) => (await tx.delete(table).returning()).length;
    const llm = await n(llmTurns);
    const msgs = await n(messages);
    const hand = await n(handoffs);
    const drafts = await n(orderDrafts);
    const sims = await n(simulatedSales);
    const profiles = await n(customerProfiles);
    const convs = await n(conversations);
    return {
      conversations: convs,
      messages: msgs,
      llmTurns: llm,
      orderDrafts: drafts,
      handoffs: hand,
      customerProfiles: profiles,
      simulatedSales: sims,
    };
  });
}
