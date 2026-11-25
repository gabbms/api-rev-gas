import { createHash, timingSafeEqual } from "node:crypto";

// WAHA (https://waha.devlike.pro) connects an ordinary WhatsApp number read by QR code. It is NOT the
// official Meta API: demo only, and the number may be banned. Adapted from the Rev-Gás project.

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<{ id: string }>;
  /** A WAHA list (sendList): the customer's choice comes back as a text message with the row title. */
  sendChoices(to: string, text: string, options: string[]): Promise<{ id: string }>;
}

export type WhatsAppErrorKind = "invalid" | "auth" | "unavailable" | "server" | "network";

/** Never carries the response body or the API key: only what kind of failure and the status. */
export class WhatsAppError extends Error {
  constructor(
    readonly kind: WhatsAppErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

type WahaOptions = { baseUrl: string; apiKey: string; session: string; fetch?: typeof fetch; timeoutMs?: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const LIST_BUTTON = "Ver opções";
const MAX_LIST_TITLE = 60;

/**
 * WAHA refuses a list without a title, and shows the title in bold. The first line becomes the title
 * (without asterisks, which would show up, and without a trailing colon); the rest is the body.
 */
export function listTitleAndBody(text: string): { title: string; description: string } {
  const [first = "", ...rest] = text.trim().split("\n");
  const title = first.replace(/\*/g, "").trim().replace(/:$/, "").trim();
  if (title === "" || title.length > MAX_LIST_TITLE) return { title: "Escolha uma opção", description: text.trim() };
  return { title, description: rest.join("\n").trim() || `Toque em ${LIST_BUTTON} para escolher.` };
}

function errorFor(status: number): WhatsAppError {
  if (status === 401 || status === 403) return new WhatsAppError("auth", `WAHA recusou a chave (HTTP ${status})`, status);
  if (status === 501) return new WhatsAppError("unavailable", "WAHA não oferece este recurso neste engine (HTTP 501)", status);
  if (status >= 500) return new WhatsAppError("server", `WAHA falhou (HTTP ${status})`, status);
  return new WhatsAppError("invalid", `WAHA recusou o pedido (HTTP ${status})`, status);
}

/** The sent message id changes shape between WAHA versions; if none fits, make one up (the send worked). */
function messageId(json: unknown): string {
  if (isObj(json)) {
    const id = json.id;
    if (typeof id === "string") return id;
    if (isObj(id) && typeof id._serialized === "string") return id._serialized;
    const data = json._data;
    if (isObj(data) && isObj(data.id) && typeof data.id._serialized === "string") return data.id._serialized;
  }
  return `waha.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

export function createWahaSender(o: WahaOptions): WhatsAppSender {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs ?? 15_000;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: { "X-Api-Key": o.apiKey, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WhatsAppError("network", "WAHA não respondeu");
    }
    if (!res.ok) throw errorFor(res.status);
    return res;
  }

  async function post(path: string, body: Obj): Promise<{ id: string }> {
    const res = await request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: o.session, ...body }),
    });
    return { id: messageId(await res.json().catch(() => undefined)) };
  }

  // Older Brazilian numbers have no ninth digit on WhatsApp: WAHA says which address is right.
  const chatIds = new Map<string, string>();
  async function chatId(to: string): Promise<string> {
    const digits = to.replace(/\D/g, "");
    const cached = chatIds.get(digits);
    if (cached) return cached;
    let resolved = `${digits}@c.us`;
    try {
      const res = await request(`${base}/api/contacts/check-exists?phone=${digits}&session=${encodeURIComponent(o.session)}`);
      const j: unknown = await res.json();
      if (isObj(j) && j.numberExists === true && typeof j.chatId === "string") resolved = j.chatId;
    } catch {
      // Without the check, try the number as it came (and do not cache the guess).
      return resolved;
    }
    chatIds.set(digits, resolved);
    return resolved;
  }

  return {
    async sendText(to, text) {
      return post("/api/sendText", { chatId: await chatId(to), text });
    },
    // Lists need the GOWS (or NOWEB) engine: on WEBJS WAHA answers 501 and the caller falls back to text.
    async sendChoices(to, text, options) {
      return post("/api/sendList", {
        chatId: await chatId(to),
        message: {
          ...listTitleAndBody(text),
          button: LIST_BUTTON,
          sections: [{ title: "Opções", rows: options.map((title, i) => ({ title, rowId: `opcao_${i + 1}`, description: null })) }],
        },
      });
    },
  };
}

/** The media file is larger than the configured limit (it was not read in full). */
export class MediaTooLargeError extends Error {
  constructor() {
    super("arquivo de mídia maior que o limite");
    this.name = "MediaTooLargeError";
  }
}

const MEDIA_PATH = "/api/files/";

/**
 * Downloads a file WAHA announced in a webhook. Only the URL's path (and query) is used, on
 * WAHA_URL: the host in the webhook is the container's own and must never be trusted. Paths outside
 * /api/files/ are refused without any request. Files above `maxBytes` are refused without reading
 * them whole. No automatic retry.
 */
export function createWahaMediaDownloader(o: {
  baseUrl: string;
  apiKey: string;
  maxBytes: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): (url: string) => Promise<{ data: Uint8Array; mime: string }> {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  return async (url) => {
    let path: string;
    try {
      const u = new URL(url);
      path = `${u.pathname}${u.search}`;
    } catch {
      throw new WhatsAppError("invalid", "endereço de mídia inválido");
    }
    if (!path.startsWith(MEDIA_PATH)) throw new WhatsAppError("invalid", "endereço de mídia fora do WAHA");

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: { "X-Api-Key": o.apiKey },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new WhatsAppError("network", "WAHA não respondeu");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw errorFor(res.status);
    }
    const mime = res.headers.get("content-type") ?? "";
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new MediaTooLargeError();
    }
    if (!res.body) return { data: new Uint8Array(), mime };

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > o.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MediaTooLargeError();
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof MediaTooLargeError) throw e;
      throw new WhatsAppError("network", "falha ao baixar a mídia do WAHA");
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.byteLength;
    }
    return { data, mime };
  };
}

/**
 * New WhatsApp contacts may arrive as `<id>@lid` (no phone). WAHA knows each one's phone
 * (`/api/<session>/lids/<lid>`). Returns only the digits, or undefined when unknown.
 */
export function createWahaLidResolver(o: WahaOptions): (lid: string) => Promise<string | undefined> {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const cache = new Map<string, string>();
  return async (lid) => {
    const cached = cache.get(lid);
    if (cached) return cached;
    try {
      const res = await doFetch(`${base}/api/${encodeURIComponent(o.session)}/lids/${encodeURIComponent(lid)}`, {
        headers: { "X-Api-Key": o.apiKey },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      if (!res.ok) return undefined;
      const j: unknown = await res.json();
      const pn = isObj(j) && typeof j.pn === "string" ? j.pn : "";
      const digits = pn.endsWith("@c.us") ? pn.slice(0, -"@c.us".length).replace(/\D/g, "") : "";
      if (digits === "") return undefined;
      cache.set(lid, digits);
      return digits;
    } catch {
      return undefined;
    }
  };
}

/** Compares the header with the configured secret in constant time (hashes have equal length). */
export function verifyWahaSecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(header), h(secret));
}
