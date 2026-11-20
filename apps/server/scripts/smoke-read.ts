// Read-only smoke test against the real RevGás API. Never creates sales.
// Usage: pnpm --filter server exec tsx scripts/smoke-read.ts <phone>
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "../src/config.js";
import { HttpRevgasClient } from "../src/revgas/httpClient.js";
import { RateLimiter } from "../src/revgas/rateLimiter.js";
import { RevgasError } from "../src/revgas/types.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);
const client = new HttpRevgasClient(cfg, new RateLimiter(1000));
const phone = process.argv[2];

const products = await client.listProducts(cfg.revgasEstablishmentId);
const active = products.filter((p) => !p.inactive);
console.log(`Produtos do estabelecimento ${cfg.revgasEstablishmentId}: ${products.length} (${active.length} ativos)`);
for (const p of active.slice(0, 3)) console.log(`  ${p.id}  ${p.description}`);

if (phone) {
  try {
    const customers = await client.findCustomersByPhone(phone);
    console.log(`Clientes com o telefone informado: ${customers.length}`);
    for (const c of customers) console.log(`  ${c.id}  ${c.name}`);
  } catch (e) {
    if (e instanceof RevgasError) console.log(`Busca de cliente falhou: ${e.kind} (${e.status ?? "-"}) ${e.message}`);
    else throw e;
  }
}
