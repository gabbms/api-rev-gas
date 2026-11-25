import type { TranscriptionError, Transcriber } from "./transcriber.js";

/** In-memory transcriber for tests: answers `next` (text or an error) and records each call. */
export class FakeTranscriber implements Transcriber {
  calls: { bytes: number; mime: string }[] = [];
  next: string | TranscriptionError = "";

  async transcribe(audio: Uint8Array, mime: string): Promise<string> {
    this.calls.push({ bytes: audio.byteLength, mime });
    if (typeof this.next !== "string") throw this.next;
    return this.next;
  }
}
