import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { Catalog } from "./catalog/catalog.js";
import { loadConfig } from "./config.js";
import { ConversationService } from "./conversations/conversationService.js";
import { createDb } from "./db/client.js";
import { Hub, buildServer } from "./http/server.js";
import { OrderService } from "./orders/orderService.js";
import { createRevgasClient } from "./revgas/httpClient.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);

const prices = JSON.parse(readFileSync(new URL("../config/prices.json", import.meta.url), "utf8")) as Record<string, number>;
const { db, close } = createDb(cfg.databaseUrl);
const revgas = createRevgasClient(cfg);
const catalog = new Catalog(revgas, cfg.revgasEstablishmentId, prices);
const orders = new OrderService(db, catalog, revgas, cfg);
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
