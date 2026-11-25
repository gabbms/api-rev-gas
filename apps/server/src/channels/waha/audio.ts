import { TranscriptionError, type Transcriber } from "../../audio/transcriber.js";
import type { Inbound } from "../../conversations/conversationService.js";
import { MediaTooLargeError, WhatsAppError } from "./client.js";
import type { InboundMessage } from "./webhook.js";

type Download = (url: string) => Promise<{ data: Uint8Array; mime: string }>;

const kindOf = (e: unknown) =>
  e instanceof TranscriptionError || e instanceof WhatsAppError ? `${e.kind}${e.status ? ` ${e.status}` : ""}` : e instanceof Error ? e.name : "erro";

/**
 * Turns a WhatsApp message into what the conversation takes: voice notes are downloaded from WAHA
 * and transcribed. Logs only the kind of failure and how long it took, never the transcription.
 * `transcriber: null` (AUDIO_TRANSCRIPTION=off): voice notes get today's "text only" reply.
 */
export function createAudioToInbound(deps: {
  download: Download;
  transcriber: Transcriber | null;
}): (m: InboundMessage) => Promise<Pick<Inbound, "kind" | "text">> {
  return async (m) => {
    if (m.kind !== "audio") return { kind: m.kind, text: m.text };
    if (!deps.transcriber || !m.media) return { kind: "unsupported", text: "[áudio]" };

    const started = Date.now();
    const ms = () => `${Date.now() - started} ms`;
    let file: { data: Uint8Array; mime: string };
    try {
      file = await deps.download(m.media.url);
    } catch (e) {
      if (e instanceof MediaTooLargeError) {
        console.warn(`[áudio] arquivo acima de AUDIO_MAX_BYTES; não transcrito (${ms()})`);
        return { kind: "audio_too_long", text: "[áudio longo demais]" };
      }
      console.error(`[áudio] falha ao baixar do WAHA (${kindOf(e)}, ${ms()})`);
      return { kind: "audio_failed", text: "[áudio não transcrito]" };
    }

    let text: string;
    try {
      text = (await deps.transcriber.transcribe(file.data, file.mime || m.media.mime)).trim();
    } catch (e) {
      console.error(`[áudio] falha na transcrição (${kindOf(e)}, ${ms()})`);
      return { kind: "audio_failed", text: "[áudio não transcrito]" };
    }
    if (text === "") {
      console.warn(`[áudio] transcrição vazia (${ms()})`);
      return { kind: "audio_failed", text: "[áudio não transcrito]" };
    }
    console.info(`[áudio] transcrito em ${ms()}`);
    return { kind: "audio", text };
  };
}
