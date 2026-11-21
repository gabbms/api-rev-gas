import { z } from "zod";

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
  REVGAS_PRODUCT_IDS: z
    .string()
    .regex(/^\s*\d+(\s*,\s*\d+)*\s*$/, { error: "REVGAS_PRODUCT_IDS deve ser uma lista de ids separados por vírgula" })
    .optional(),
  REVGAS_BROADCAST: z.enum(["NONE", "NEW_SALE"], { error: "REVGAS_BROADCAST deve ser NONE ou NEW_SALE" }).default("NONE"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"], { error: "ANTHROPIC_EFFORT deve ser low, medium ou high" }).default("medium"),
  PORT: z.coerce.number({ error: "PORT deve ser um número" }).int().positive().default(3333),
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
  /** Only these products (and their cylinders) are offered; null = every product with a deal. */
  revgasProductIds: number[] | null;
  revgasBroadcast: "NONE" | "NEW_SALE";
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicEffort: "low" | "medium" | "high";
  port: number;
  maxItemQuantity: number;
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
  return {
    databaseUrl: e.DATABASE_URL,
    revgasApiKey: e.REVGAS_API_KEY,
    revgasBaseUrl: e.REVGAS_BASE_URL.replace(/\/+$/, ""),
    revgasEstablishmentId: e.REVGAS_ESTABLISHMENT_ID,
    revgasWriteEnabled: e.REVGAS_WRITE_ENABLED === "true",
    revgasCustomersEnabled: e.REVGAS_CUSTOMERS_ENABLED === "true",
    revgasProductIds: e.REVGAS_PRODUCT_IDS ? e.REVGAS_PRODUCT_IDS.split(",").map((s) => Number(s.trim())) : null,
    revgasBroadcast: e.REVGAS_BROADCAST,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    anthropicEffort: e.ANTHROPIC_EFFORT,
    port: e.PORT,
    maxItemQuantity: e.MAX_ITEM_QUANTITY,
  };
}
