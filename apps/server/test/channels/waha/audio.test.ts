import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTranscriber } from "../../../src/audio/fakeTranscriber.js";
import { TranscriptionError } from "../../../src/audio/transcriber.js";
import { createAudioToInbound } from "../../../src/channels/waha/audio.js";
import { MediaTooLargeError, WhatsAppError } from "../../../src/channels/waha/client.js";
import { FakeMediaDownloader } from "../../../src/channels/waha/fakeClient.js";
import type { InboundMessage } from "../../../src/channels/waha/webhook.js";

const base = { id: "m1", from: "5586999998888", profileName: null, at: new Date() };
const voice: InboundMessage = {
  ...base,
  kind: "audio",
  text: "[áudio]",
  media: { url: "http://localhost:3000/api/files/default/x.oga", mime: "audio/ogg; codecs=opus" },
};

let dl: FakeMediaDownloader;
let tr: FakeTranscriber;
let logs: string[];

beforeEach(() => {
  dl = new FakeMediaDownloader();
  tr = new FakeTranscriber();
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

const toInbound = () => createAudioToInbound({ download: dl.download, transcriber: tr });

describe("createAudioToInbound", () => {
  it("passes text and unsupported messages through, without downloading", async () => {
    expect(await toInbound()({ ...base, kind: "text", text: "oi" })).toEqual({ kind: "text", text: "oi" });
    expect(await toInbound()({ ...base, kind: "unsupported", text: "[imagem]" })).toEqual({ kind: "unsupported", text: "[imagem]" });
    expect(dl.urls).toEqual([]);
  });

  it("Review Focus 4: with transcription off, audio is unsupported and nothing is downloaded or sent", async () => {
    const off = createAudioToInbound({ download: dl.download, transcriber: null });
    expect(await off(voice)).toEqual({ kind: "unsupported", text: "[áudio]" });
    expect(dl.urls).toEqual([]);
    expect(tr.calls).toEqual([]);
  });

  it("downloads the WAHA file, transcribes it with its mime and returns the text", async () => {
    tr.next = "quero um botijão no pix";
    expect(await toInbound()(voice)).toEqual({ kind: "audio", text: "quero um botijão no pix" });
    expect(dl.urls).toEqual([voice.media!.url]);
    expect(tr.calls).toEqual([{ bytes: 3, mime: "audio/ogg; codecs=opus" }]);
  });

  it("uses the message's mime when the download has none", async () => {
    dl.next = { data: new Uint8Array([1]), mime: "" };
    tr.next = "oi";
    await toInbound()(voice);
    expect(tr.calls[0]!.mime).toBe("audio/ogg; codecs=opus");
  });

  it("an empty transcription → audio_failed", async () => {
    tr.next = "";
    expect(await toInbound()(voice)).toEqual({ kind: "audio_failed", text: "[áudio não transcrito]" });
  });

  it.each([
    ["auth", new TranscriptionError("auth", "x", 401)],
    ["rate_limited", new TranscriptionError("rate_limited", "x", 429)],
    ["network", new TranscriptionError("network", "x")],
  ])("Review Focus 4: a transcription error (%s) → audio_failed, logging only the kind and the time", async (_k, err) => {
    tr.next = err;
    expect(await toInbound()(voice)).toEqual({ kind: "audio_failed", text: "[áudio não transcrito]" });
    expect(logs.join("\n")).toMatch(/\d+ ms/);
  });

  it("a download error → audio_failed, without calling the transcriber", async () => {
    dl.next = new WhatsAppError("auth", "x", 401);
    expect(await toInbound()(voice)).toEqual({ kind: "audio_failed", text: "[áudio não transcrito]" });
    expect(tr.calls).toEqual([]);
  });

  it("a file over the limit → audio_too_long, without calling the transcriber", async () => {
    dl.next = new MediaTooLargeError();
    expect(await toInbound()(voice)).toEqual({ kind: "audio_too_long", text: "[áudio longo demais]" });
    expect(tr.calls).toEqual([]);
  });

  it("never logs the transcription", async () => {
    tr.next = "meu endereço secreto";
    await toInbound()(voice);
    expect(logs.join("\n")).not.toContain("secreto");
  });
});
