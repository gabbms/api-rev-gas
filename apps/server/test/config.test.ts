import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REVGAS_API_KEY: "secret-revgas-value-123",
  ANTHROPIC_API_KEY: "secret-anthropic-value-456",
};

describe("loadConfig", () => {
  it("throws an error naming REVGAS_API_KEY when it is missing", () => {
    expect(() => loadConfig({})).toThrow(/REVGAS_API_KEY/);
  });

  it("applies safe defaults with only the required variables", () => {
    const cfg = loadConfig({ ...required });
    expect(cfg.revgasWriteEnabled).toBe(false);
    expect(cfg.revgasBroadcast).toBe("NONE");
    expect(cfg.revgasEstablishmentId).toBe(2580);
    expect(cfg.anthropicModel).toBe("claude-opus-5-5");
    expect(cfg.anthropicEffort).toBe("medium");
    expect(cfg.revgasBaseUrl).toBe("https://api.revgas.com/v1");
    expect(cfg.port).toBe(3333);
    expect(cfg.maxItemQuantity).toBe(10);
    expect(cfg.databaseUrl).toBe(required.DATABASE_URL);
    expect(cfg.revgasApiKey).toBe(required.REVGAS_API_KEY);
    expect(cfg.anthropicApiKey).toBe(required.ANTHROPIC_API_KEY);
  });

  it("enables writes only for the exact string 'true'", () => {
    expect(loadConfig({ ...required, REVGAS_WRITE_ENABLED: "true" }).revgasWriteEnabled).toBe(true);
    for (const v of ["TRUE", "1", "yes", "false", ""]) {
      expect(loadConfig({ ...required, REVGAS_WRITE_ENABLED: v }).revgasWriteEnabled).toBe(false);
    }
  });

  it("never includes variable values in the error message", () => {
    const env = {
      DATABASE_URL: "postgres://leaky-db-value",
      ANTHROPIC_API_KEY: "leaky-anthropic-value",
      REVGAS_BROADCAST: "leaky-broadcast-value",
      REVGAS_ESTABLISHMENT_ID: "leaky-establishment-value",
    };
    let message = "";
    try {
      loadConfig(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    for (const value of Object.values(env)) {
      expect(message).not.toContain(value);
    }
  });
});
