// Read-only smoke test against the real RevGás API. Never creates sales.
// Usage: pnpm --filter server exec tsx scripts/smoke-read.ts [phone]
import { config as loadDotenv } from "dotenv";
import { Catalog, referencePriceCents } from "../src/catalog/catalog.js";
import { loadConfig } from "../src/config.js";
import { formatCents } from "../src/orders/draft.js";
import { HttpRevgasClient } from "../src/revgas/httpClient.js";
import { RateLimiter } from "../src/revgas/rateLimiter.js";
import { RevgasError } from "../src/revgas/types.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);
const client = new HttpRevgasClient(cfg, new RateLimiter(1000));
const phone = process.argv[2];

const started = Date.now();
const sellable = await new Catalog(client, cfg.revgasEstablishmentId).list();
console.log(
  `Estabelecimento ${cfg.revgasEstablishmentId}: ${sellable.length} produtos com acordo de preço (${((Date.now() - started) / 1000).toFixed(1)} s)`,
);
for (const p of sellable.slice(0, 5)) {
  const ref = referencePriceCents(p.pricesCents);
  const types = Object.keys(p.pricesCents).join(", ");
  console.log(`  ${p.productId}  ${p.description}  ${ref === null ? "-" : formatCents(ref)}  [${types}]${p.containerId ? `  vasilhame ${p.containerId}` : ""}`);
}

if (phone) {
  try {
    const customers = await client.findCustomersByPhone(phone);
    console.log(`Clientes com o telefone informado: ${customers.length}`);
  } catch (e) {
    if (e instanceof RevgasError) console.log(`Busca de cliente: ${e.kind} (${e.status ?? "-"}) ${e.message}`);
    else throw e;
  }
}
