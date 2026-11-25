import { z } from "zod";
import { normalizePhone } from "./revgas/phone.js";

const required = (name: string) =>
  z.string({ error: `${name} é obrigatória` }).min(1, { error: `${name} é obrigatória` });

const envSchema = z.object({
  DATABASE_URL: required("DATABASE_URL"),
  REVGAS_API_KEY: required("REVGAS_API_KEY"),
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  REVGAS_BASE_URL: z.string().url({ error: "REVGAS_BASE_URL inválida" }).default("https://api.revgas.com/v1"),
  REVGAS_ESTABLISHMENT_ID: z.coerce
    .number({ error: "REVGAS_ESTABLISHMENT_ID deve ser um número" })
    .int({ error: "REVGAS_ESTABLISHMENT_ID deve ser inteiro" })
    .positive({ error: "REVGAS_ESTABLISHMENT_ID deve ser positivo" })
    .default(2580),
  REVGAS_WRITE_ENABLED: z.string().optional(),
  REVGAS_CUSTOMERS_ENABLED: z.string().optional(),
  REVGAS_VALEGAS_ENABLED: z.string().optional(),
  REVGAS_PRICE_PRIORITY: z.string().optional(),
  REVGAS_PRODUCT_IDS: z
    .string()
    .regex(/^\s*\d+(\s*,\s*\d+)*\s*$/, { error: "REVGAS_PRODUCT_IDS deve ser uma lista de ids separados por vírgula" })
    .optional(),
  DEFAULT_CITY: z.string().trim().min(1).default("Teresina"),
  DEFAULT_STATE: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, { error: "DEFAULT_STATE deve ser a sigla do estado (ex.: PI)" })
    .transform((s) => s.toUpperCase())
    .default("PI"),
  REVGAS_BROADCAST: z.enum(["NONE", "NEW_SALE"], { error: "REVGAS_BROADCAST deve ser NONE ou NEW_SALE" }).default("NONE"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"], { error: "ANTHROPIC_EFFORT deve ser low, medium ou high" }).default("medium"),
  PORT: z.coerce.number({ error: "PORT deve ser um número" }).int().positive().default(3333),
  WHATSAPP_PROVIDER: z.enum(["off", "waha"], { error: "WHATSAPP_PROVIDER deve ser off ou waha" }).default("off"),
  WAHA_URL: z.string().url({ error: "WAHA_URL inválida" }).default("http://localhost:3002"),
  WAHA_API_KEY: z.string().optional(),
  WAHA_WEBHOOK_SECRET: z.string().optional(),
  WAHA_SESSION: z.string().trim().min(1).default("default"),
  WHATSAPP_WEBHOOK_PORT: z.coerce.number({ error: "WHATSAPP_WEBHOOK_PORT deve ser um número" }).int().positive().default(3334),
  WHATSAPP_ALLOWED_NUMBERS: z.string().optional(),
  MAX_ITEM_QUANTITY: z.coerce.number({ error: "MAX_ITEM_QUANTITY deve ser um número" }).int().positive().default(10),
});

export type AppConfig = {
  databaseUrl: string;
  revgasApiKey: string;
  revgasBaseUrl: string;
  revgasEstablishmentId: number;
  revgasWriteEnabled: boolean;
  /** C1: query RevGás /customers (403 for the current token) after the local profile. */
  revgasCustomersEnabled: boolean;
  /** Accept Vale Gás (coupon code sent in payments[].serial). */
  revgasValegasEnabled: boolean;
  /** Price from the customer deal > customer category (TAG) deal > general deal, for identified customers. */
  revgasPricePriority: boolean;
  /** Only these products (and their cylinders) are offered; null = every product with a deal. */
  revgasProductIds: number[] | null;
  revgasBroadcast: "NONE" | "NEW_SALE";
  /** Delivery city/state assumed when the customer does not say another. */
  defaultCity: string;
  defaultState: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicEffort: "low" | "medium" | "high";
  port: number;
  maxItemQuantity: number;
  /** WhatsApp channel. "waha" is unofficial (demo only); "off" keeps only the simulated chat. */
  whatsappProvider: "off" | "waha";
  wahaUrl: string;
  /** Required with waha. Never logged. */
  wahaApiKey: string | null;
  /** Required with waha: the X-Revgas-Secret header WAHA sends on every webhook. Never logged. */
  wahaWebhookSecret: string | null;
  wahaSession: string;
  /** The webhook server's own port (only POST /webhooks/waha). */
  whatsappWebhookPort: number;
  /** DDD + number of who may use the bot over WhatsApp; null = anyone. */
  whatsappAllowedNumbers: string[] | null;
};

/** Reads and validates configuration. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Treat empty strings as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const name = String(i.path[0] ?? "configuração");
      return i.message.includes(name) ? i.message : `${name}: valor inválido`;
    });
    throw new Error(`Configuração inválida: ${[...new Set(problems)].join("; ")}`);
  }
  const e = parsed.data;
  const problems: string[] = [];
  if (e.WHATSAPP_PROVIDER === "waha") {
    if (!e.WAHA_API_KEY) problems.push("WAHA_API_KEY é obrigatória com WHATSAPP_PROVIDER=waha");
    if (!e.WAHA_WEBHOOK_SECRET) problems.push("WAHA_WEBHOOK_SECRET é obrigatória com WHATSAPP_PROVIDER=waha");
  }
  let allowed: string[] | null = null;
  if (e.WHATSAPP_ALLOWED_NUMBERS) {
    const raw = e.WHATSAPP_ALLOWED_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean);
    const normalized = raw.map((n) => normalizePhone(n));
    if (normalized.some((n) => n === null)) problems.push("WHATSAPP_ALLOWED_NUMBERS deve ter telefones com DDD separados por vírgula");
    else allowed = normalized as string[];
  }
  if (problems.length) throw new Error(`Configuração inválida: ${problems.join("; ")}`);
  return {
    databaseUrl: e.DATABASE_URL,
    revgasApiKey: e.REVGAS_API_KEY,
    revgasBaseUrl: e.REVGAS_BASE_URL.replace(/\/+$/, ""),
    revgasEstablishmentId: e.REVGAS_ESTABLISHMENT_ID,
    revgasWriteEnabled: e.REVGAS_WRITE_ENABLED === "true",
    revgasCustomersEnabled: e.REVGAS_CUSTOMERS_ENABLED === "true",
    revgasValegasEnabled: e.REVGAS_VALEGAS_ENABLED === "true",
    revgasPricePriority: e.REVGAS_PRICE_PRIORITY === "true",
    revgasProductIds: e.REVGAS_PRODUCT_IDS ? e.REVGAS_PRODUCT_IDS.split(",").map((s) => Number(s.trim())) : null,
    revgasBroadcast: e.REVGAS_BROADCAST,
    defaultCity: e.DEFAULT_CITY,
    defaultState: e.DEFAULT_STATE,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    anthropicEffort: e.ANTHROPIC_EFFORT,
    port: e.PORT,
    maxItemQuantity: e.MAX_ITEM_QUANTITY,
    whatsappProvider: e.WHATSAPP_PROVIDER,
    wahaUrl: e.WAHA_URL.replace(/\/+$/, ""),
    wahaApiKey: e.WAHA_API_KEY ?? null,
    wahaWebhookSecret: e.WAHA_WEBHOOK_SECRET ?? null,
    wahaSession: e.WAHA_SESSION,
    whatsappWebhookPort: e.WHATSAPP_WEBHOOK_PORT,
    whatsappAllowedNumbers: allowed,
  };
}
