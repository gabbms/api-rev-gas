// Clears the development database before a presentation. Never touches RevGás nor the test database.
// Usage: pnpm --filter server demo:reset
import { config as loadDotenv } from "dotenv";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { CONFIRMATION, checkResetAllowed, wipeDemoData } from "../src/demo/reset.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);
const env = { databaseUrl: cfg.databaseUrl, databaseUrlTest: process.env.DATABASE_URL_TEST, writeEnabled: cfg.revgasWriteEnabled };

// Checked before asking, so a refused run never shows the prompt.
const early = checkResetAllowed(env, CONFIRMATION);
if (early) {
  console.error(early);
  process.exit(1);
}

console.log(`Isto apaga conversas, mensagens, rascunhos, perfis de clientes e vendas simuladas do banco "${new URL(cfg.databaseUrl).pathname.slice(1)}".`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = await rl.question(`Digite ${CONFIRMATION} para confirmar: `);
rl.close();

const refused = checkResetAllowed(env, typed);
if (refused) {
  console.error(refused);
  process.exit(1);
}

const { db, close } = createDb(cfg.databaseUrl);
const counts = await wipeDemoData(db);
await close();
console.log("Apagado:", Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
