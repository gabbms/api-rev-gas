// Checks the RevGás-dependent configuration and reads each route the bot uses. Read-only.
// Usage: pnpm --filter server preflight
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "../src/config.js";
import { assessConfig, checkWhatsapp, formatReport, probeRoutes } from "../src/preflight/preflight.js";
import { RateLimiter } from "../src/revgas/rateLimiter.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url), quiet: true });
const cfg = loadConfig(process.env);
const probes = await probeRoutes(cfg, new RateLimiter(1000));
console.log(formatReport(assessConfig(cfg, probes), probes, await checkWhatsapp(cfg)));
