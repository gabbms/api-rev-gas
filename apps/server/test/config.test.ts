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

  it("C1: keeps the RevGás customer lookup off unless REVGAS_CUSTOMERS_ENABLED is exactly 'true'", () => {
    expect(loadConfig({ ...required }).revgasCustomersEnabled).toBe(false);
    expect(loadConfig({ ...required, REVGAS_CUSTOMERS_ENABLED: "true" }).revgasCustomersEnabled).toBe(true);
    expect(loadConfig({ ...required, REVGAS_CUSTOMERS_ENABLED: "1" }).revgasCustomersEnabled).toBe(false);
  });

  it("reads REVGAS_PRODUCT_IDS as an optional list of product ids", () => {
    expect(loadConfig({ ...required }).revgasProductIds).toBeNull();
    expect(loadConfig({ ...required, REVGAS_PRODUCT_IDS: " 23740, 23974 ,24141" }).revgasProductIds).toEqual([23740, 23974, 24141]);
    expect(() => loadConfig({ ...required, REVGAS_PRODUCT_IDS: "23740,abc" })).toThrow(/REVGAS_PRODUCT_IDS/);
  });

  it("reads the default delivery city and state, Teresina/PI unless set", () => {
    const d = loadConfig({ ...required });
    expect([d.defaultCity, d.defaultState]).toEqual(["Teresina", "PI"]);
    const o = loadConfig({ ...required, DEFAULT_CITY: " Parnaíba ", DEFAULT_STATE: "pi" });
    expect([o.defaultCity, o.defaultState]).toEqual(["Parnaíba", "PI"]);
    expect(() => loadConfig({ ...required, DEFAULT_STATE: "Piauí" })).toThrow(/DEFAULT_STATE/);
  });

  it("keeps Vale Gás and price priority off unless set to exactly 'true'", () => {
    const off = loadConfig({ ...required });
    expect([off.revgasValegasEnabled, off.revgasPricePriority]).toEqual([false, false]);
    const on = loadConfig({ ...required, REVGAS_VALEGAS_ENABLED: "true", REVGAS_PRICE_PRIORITY: "true" });
    expect([on.revgasValegasEnabled, on.revgasPricePriority]).toEqual([true, true]);
    const other = loadConfig({ ...required, REVGAS_VALEGAS_ENABLED: "1", REVGAS_PRICE_PRIORITY: "yes" });
    expect([other.revgasValegasEnabled, other.revgasPricePriority]).toEqual([false, false]);
  });

  describe("WhatsApp (WAHA)", () => {
    it("is off by default and requires nothing", () => {
      const c = loadConfig({ ...required });
      expect(c.whatsappProvider).toBe("off");
      expect(c.wahaUrl).toBe("http://localhost:3002");
      expect(c.wahaSession).toBe("default");
      expect(c.whatsappWebhookPort).toBe(3334);
      expect(c.whatsappAllowedNumbers).toBeNull();
      expect([c.wahaApiKey, c.wahaWebhookSecret]).toEqual([null, null]);
    });

    it("with waha, requires WAHA_WEBHOOK_SECRET and WAHA_API_KEY without leaking values", () => {
      const key = "leaky-waha-key-value";
      let message = "";
      try {
        loadConfig({ ...required, WHATSAPP_PROVIDER: "waha", WAHA_API_KEY: key });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/WAHA_WEBHOOK_SECRET/);
      expect(message).not.toContain(key);
      expect(() => loadConfig({ ...required, WHATSAPP_PROVIDER: "waha", WAHA_WEBHOOK_SECRET: "s" })).toThrow(/WAHA_API_KEY/);
      const ok = loadConfig({ ...required, WHATSAPP_PROVIDER: "waha", WAHA_API_KEY: "k", WAHA_WEBHOOK_SECRET: "s" });
      expect([ok.whatsappProvider, ok.wahaApiKey, ok.wahaWebhookSecret]).toEqual(["waha", "k", "s"]);
    });

    it("rejects an unknown provider", () => {
      expect(() => loadConfig({ ...required, WHATSAPP_PROVIDER: "meta" })).toThrow(/WHATSAPP_PROVIDER/);
    });

    it("normalizes WHATSAPP_ALLOWED_NUMBERS to DDD + number", () => {
      const c = loadConfig({ ...required, WHATSAPP_ALLOWED_NUMBERS: "5586911112222, 86933334444" });
      expect(c.whatsappAllowedNumbers).toEqual(["86911112222", "86933334444"]);
      expect(() => loadConfig({ ...required, WHATSAPP_ALLOWED_NUMBERS: "86911112222,123" })).toThrow(/WHATSAPP_ALLOWED_NUMBERS/);
    });
  });

  describe("audio transcription", () => {
    const waha = { WHATSAPP_PROVIDER: "waha", WAHA_API_KEY: "k", WAHA_WEBHOOK_SECRET: "s" };

    it("is off by default and requires nothing", () => {
      const c = loadConfig({ ...required });
      expect(c.audioTranscription).toBe("off");
      expect(c.groqApiKey).toBeNull();
      expect(c.transcribeUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(c.transcribeModel).toBe("whisper-large-v3-turbo");
      expect(c.audioMaxBytes).toBe(2_000_000);
    });

    it("groq requires GROQ_API_KEY, naming it without values", () => {
      expect(() => loadConfig({ ...required, ...waha, AUDIO_TRANSCRIPTION: "groq" })).toThrow(/GROQ_API_KEY/);
      const c = loadConfig({ ...required, ...waha, AUDIO_TRANSCRIPTION: "groq", GROQ_API_KEY: "groq-key-should-never-leak", AUDIO_MAX_BYTES: "500000" });
      expect([c.audioTranscription, c.groqApiKey, c.audioMaxBytes]).toEqual(["groq", "groq-key-should-never-leak", 500000]);
    });

    it("groq requires WHATSAPP_PROVIDER=waha", () => {
      let message = "";
      try {
        loadConfig({ ...required, AUDIO_TRANSCRIPTION: "groq", GROQ_API_KEY: "groq-key-should-never-leak" });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/WHATSAPP_PROVIDER=waha/);
      expect(message).not.toContain("groq-key-should-never-leak");
    });

    it("rejects an unknown provider", () => {
      expect(() => loadConfig({ ...required, AUDIO_TRANSCRIPTION: "openai" })).toThrow(/AUDIO_TRANSCRIPTION/);
    });
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
