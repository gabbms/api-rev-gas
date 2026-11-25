// Speech to text for WhatsApp voice notes. Works with Groq and any provider with the OpenAI
// transcription interface (change url, model and key). Adapted from the Rev-Gás project.

export interface Transcriber {
  transcribe(audio: Uint8Array, mime: string): Promise<string>;
}

export type TranscriptionErrorKind = "auth" | "rate_limited" | "invalid" | "server" | "network";

/** Never carries the response body or the key: only the kind of failure and the status. */
export class TranscriptionError extends Error {
  constructor(
    readonly kind: TranscriptionErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

const EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/amr": "amr",
};

/** Mime without parameters ("audio/ogg; codecs=opus" → "audio/ogg"). */
export function baseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

export function audioFileName(mime: string): string {
  return `audio.${EXT[baseMime(mime)] ?? "bin"}`;
}

function errorFor(status: number): TranscriptionError {
  if (status === 401 || status === 403) return new TranscriptionError("auth", `transcrição recusou a chave (HTTP ${status})`, status);
  if (status === 429) return new TranscriptionError("rate_limited", "limite de transcrições atingido (HTTP 429)", status);
  if (status >= 500) return new TranscriptionError("server", `serviço de transcrição falhou (HTTP ${status})`, status);
  return new TranscriptionError("invalid", `transcrição recusou o áudio (HTTP ${status})`, status);
}

/** One request per audio, no automatic retry: on failure the customer is asked to write. */
export function createOpenAICompatibleTranscriber(o: {
  apiKey: string;
  url: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Transcriber {
  const doFetch = o.fetch ?? fetch;
  return {
    async transcribe(audio, mime) {
      const base = baseMime(mime);
      const form = new FormData();
      form.set("model", o.model);
      form.set("language", "pt");
      form.set("file", new Blob([new Uint8Array(audio)], { type: base }), audioFileName(base));
      let res: Response;
      try {
        res = await doFetch(o.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${o.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
        });
      } catch {
        throw new TranscriptionError("network", "serviço de transcrição não respondeu");
      }
      if (!res.ok) throw errorFor(res.status);
      const json = (await res.json().catch(() => ({}))) as { text?: unknown };
      return typeof json.text === "string" ? json.text.trim() : "";
    },
  };
}
