import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { Catalog } from "./catalog/catalog.js";
import { createOutgoingRouter } from "./channels/router.js";
import { createWahaLidResolver, createWahaSender } from "./channels/waha/client.js";
import { buildWahaWebhookServer } from "./channels/waha/server.js";
import { loadConfig } from "./config.js";
import { ConversationService } from "./conversations/conversationService.js";
import { createDb } from "./db/client.js";
import { Hub, buildServer } from "./http/server.js";
import { OrderService } from "./orders/orderService.js";
import { createRevgasClient } from "./revgas/httpClient.js";
import { acceptedPaymentTypes } from "./revgas/types.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);

const { db, close } = createDb(cfg.databaseUrl);
const revgas = createRevgasClient(cfg, db);
// C2: prices come from RevGás deals (/deals), cached; warmed up now so the first customer doesn't wait.
const catalog = new Catalog(revgas, cfg.revgasEstablishmentId, {
  productIds: cfg.revgasProductIds,
  acceptedPayments: acceptedPaymentTypes(cfg.revgasValegasEnabled),
});
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
// WhatsApp (WAHA) only when WHATSAPP_PROVIDER=waha; loadConfig already required its secrets.
const waha =
  cfg.whatsappProvider === "waha"
    ? { baseUrl: cfg.wahaUrl, apiKey: cfg.wahaApiKey!, session: cfg.wahaSession }
    : null;
const conversations = new ConversationService(
  { anthropic, orders, catalog, revgas, db, cfg },
  createOutgoingRouter({ db, hub, whatsapp: waha ? createWahaSender(waha) : null }),
  (id) => hub.changed(id),
);
hub.attach(conversations);

const app = await buildServer({ cfg, conversations, hub, db, logger: true });
app.addHook("onClose", async () => close());

await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.info(
  cfg.revgasWriteEnabled
    ? "[revgas] ATENÇÃO: escrita LIGADA — vendas serão criadas na RevGás"
    : "[revgas] escrita desligada: vendas são simuladas",
);

// The webhook has its own server and port, with only POST /webhooks/waha; the panel never sees WAHA traffic.
const webhook = waha
  ? buildWahaWebhookServer({
      cfg,
      db,
      resolveLid: createWahaLidResolver(waha),
      onInbound: (m, receivedAt) =>
        conversations.handleInbound({ channel: "whatsapp", address: m.from, rawPhone: m.from, text: m.text, kind: m.kind, receivedAt }),
    })
  : null;
if (webhook) {
  await webhook.listen({ port: cfg.whatsappWebhookPort, host: "127.0.0.1" });
  console.warn("[whatsapp] aviso: WhatsApp não oficial (WAHA), só para demonstração; o número pode ser banido");
  console.info(
    `[whatsapp] webhook em http://127.0.0.1:${cfg.whatsappWebhookPort}/webhooks/waha` +
      (cfg.whatsappAllowedNumbers ? ` (só ${cfg.whatsappAllowedNumbers.length} número(s) permitidos)` : " (qualquer número)"),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void Promise.all([app.close(), webhook?.close()]).then(() => process.exit(0)));
}
