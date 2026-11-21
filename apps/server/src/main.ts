import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { Catalog } from "./catalog/catalog.js";
import { loadConfig } from "./config.js";
import { ConversationService } from "./conversations/conversationService.js";
import { createDb } from "./db/client.js";
import { Hub, buildServer } from "./http/server.js";
import { OrderService } from "./orders/orderService.js";
import { createRevgasClient } from "./revgas/httpClient.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);

const { db, close } = createDb(cfg.databaseUrl);
const revgas = createRevgasClient(cfg, db);
// C2: prices come from RevGás deals (/deals), cached; warmed up now so the first customer doesn't wait.
const catalog = new Catalog(revgas, cfg.revgasEstablishmentId, undefined, undefined, cfg.revgasProductIds);
void catalog
  .list()
  .then((items) => console.info(`[catálogo] ${items.length} produtos com preço (acordos) carregados`))
  .catch((e: unknown) => console.error("[catálogo] falha ao carregar produtos/acordos:", e instanceof Error ? e.message : e));
const orders = new OrderService(db, catalog, revgas, cfg);
// A draft left in 'sending' by a crash would block that phone forever: settle it before serving.
// Limit zero: a single server, so nothing can be mid-sale while it starts.
await orders.recoverInterruptedSales();
const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });

const hub = new Hub();
const conversations = new ConversationService(
  { anthropic, orders, catalog, revgas, db, cfg },
  (m) => hub.message(m),
  (id) => hub.changed(id),
);
hub.attach(conversations);

const app = await buildServer({ cfg, conversations, hub, logger: true });
app.addHook("onClose", async () => close());

await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.info(
  cfg.revgasWriteEnabled
    ? "[revgas] ATENÇÃO: escrita LIGADA — vendas serão criadas na RevGás"
    : "[revgas] escrita desligada: vendas são simuladas",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
