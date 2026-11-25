// Translates WAHA "message" webhooks into inbound messages. Adapted from the Rev-Gás project.

export type InboundMessage = {
  /** WhatsApp message id, used to drop repeated webhooks. */
  id: string;
  /** Sender's digits with 55, as WAHA sent them (the reply address). */
  from: string;
  profileName: string | null;
  at: Date;
  /** Text, a voice note WAHA downloaded (transcribed later), or anything else (fixed reply). */
  kind: "text" | "unsupported" | "audio";
  /** The text, or a placeholder such as "[áudio]" for audio and unsupported messages. */
  text: string;
  /** Audio only: the file as WAHA announced it (only its path is used to download). */
  media?: { url: string; mime: string };
};

/** A message from an `@lid` contact: only the phone is missing (see createWahaLidResolver). */
export type PendingLid = { lid: string; message: Omit<InboundMessage, "from"> };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function mediaPlaceholder(p: Obj): string {
  const mime = (isObj(p.media) ? str(p.media.mimetype) : undefined) ?? "";
  if (mime.startsWith("audio/")) return "[áudio]";
  if (mime === "image/webp") return "[figurinha]";
  if (mime.startsWith("image/")) return "[imagem]";
  if (mime.startsWith("video/")) return "[vídeo]";
  return "[arquivo]";
}

function content(p: Obj): Pick<InboundMessage, "kind" | "text" | "media"> {
  if (p.hasMedia === true) {
    const media = isObj(p.media) ? p.media : undefined;
    const url = media ? str(media.url) : undefined;
    const mime = (media ? str(media.mimetype) : undefined) ?? "";
    // Only a voice note WAHA actually downloaded can be transcribed; without url it stays "[áudio]".
    if (url && mime.startsWith("audio/")) return { kind: "audio", text: "[áudio]", media: { url, mime } };
    return { kind: "unsupported", text: mediaPlaceholder(p) };
  }
  const body = str(p.body) ?? "";
  return body.trim() === "" ? { kind: "unsupported", text: "[mensagem sem texto]" } : { kind: "text", text: body };
}

/**
 * Reads a WAHA `message` event. Ignores our own messages, groups, broadcasts and other events.
 * `@lid` contacts (no phone) come back in `lids` for the server to resolve.
 */
export function parseWahaWebhook(body: unknown): { messages: InboundMessage[]; lids: PendingLid[] } {
  const empty = { messages: [], lids: [] };
  if (!isObj(body) || body.event !== "message" || !isObj(body.payload)) return empty;
  const p = body.payload;
  if (p.fromMe === true) return empty;
  const id = str(p.id);
  const from = str(p.from);
  const ts = Number(p.timestamp);
  if (!id || !from || !Number.isFinite(ts)) return empty;
  const isLid = from.endsWith("@lid");
  if (!isLid && !from.endsWith("@c.us")) return empty;
  const digits = isLid ? "" : from.slice(0, -"@c.us".length).replace(/\D/g, "");
  if (!isLid && digits === "") return empty;
  const data = isObj(p._data) ? p._data : undefined;
  // The profile name moves with the engine: WEBJS uses notifyName; GOWS, Info.PushName.
  const info = data && isObj(data.Info) ? data.Info : undefined;
  const profileName = (data ? str(data.notifyName) : undefined) || (info ? str(info.PushName) : undefined) || null;
  const message = { id, profileName, at: new Date(ts * 1000), ...content(p) };
  return isLid ? { messages: [], lids: [{ lid: from, message }] } : { messages: [{ ...message, from: digits }], lids: [] };
}
