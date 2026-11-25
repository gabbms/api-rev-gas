import { describe, expect, it } from "vitest";
import { FakeTranscriber } from "../../src/audio/fakeTranscriber.js";
import { TranscriptionError, audioFileName, baseMime, createOpenAICompatibleTranscriber } from "../../src/audio/transcriber.js";

const KEY = "groq-key-should-never-leak";
const URL_ = "https://api.groq.com/openai/v1/audio/transcriptions";

function setup(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const t = createOpenAICompatibleTranscriber({
    apiKey: KEY,
    url: URL_,
    model: "whisper-large-v3-turbo",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch,
  });
  return { t, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

async function errorOf(p: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptionError);
    return e as TranscriptionError;
  }
  throw new Error("expected rejection");
}

describe("baseMime / audioFileName", () => {
  it("drops parameters and picks the extension", () => {
    expect(baseMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(audioFileName("audio/ogg; codecs=opus")).toBe("audio.ogg");
    expect(audioFileName("audio/mpeg")).toBe("audio.mp3");
    expect(audioFileName("application/x-foo")).toBe("audio.bin");
  });
});

describe("createOpenAICompatibleTranscriber", () => {
  it("posts multipart with the file, model and language=pt, with the Bearer key, and trims the text", async () => {
    const { t, calls } = setup(json({ text: "  quero um botijão no pix \n" }));
    expect(await t.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg; codecs=opus")).toBe("quero um botijão no pix");
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("pt");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(3);
  });

  it("returns an empty string when the answer has no text", async () => {
    expect(await setup(json({})).t.transcribe(new Uint8Array([1]), "audio/ogg")).toBe("");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [400, "invalid"],
    [413, "invalid"],
    [500, "server"],
    [503, "server"],
  ] as const)("Review Focus 4: HTTP %i → %s, without the key or the body in the error", async (status, kind) => {
    const body = { error: { message: `bad key ${KEY} secret-body-detail` } };
    const err = await errorOf(setup(json(body, status)).t.transcribe(new Uint8Array([1]), "audio/ogg"));
    expect(err).toMatchObject({ kind, status });
    for (const leak of [KEY, "secret-body-detail"]) {
      expect(err.message).not.toContain(leak);
      expect(String(err.stack)).not.toContain(leak);
    }
  });

  it("Review Focus 4: a network failure or timeout → network", async () => {
    expect((await errorOf(setup(new TypeError("fetch failed")).t.transcribe(new Uint8Array([1]), "audio/ogg"))).kind).toBe("network");
    expect((await errorOf(setup(new DOMException("t", "TimeoutError")).t.transcribe(new Uint8Array([1]), "audio/ogg"))).kind).toBe("network");
  });
});

describe("FakeTranscriber", () => {
  it("records the calls and answers with next", async () => {
    const f = new FakeTranscriber();
    f.next = "oi";
    expect(await f.transcribe(new Uint8Array([1, 2]), "audio/ogg")).toBe("oi");
    expect(f.calls).toEqual([{ bytes: 2, mime: "audio/ogg" }]);
    f.next = new TranscriptionError("rate_limited", "x", 429);
    await expect(f.transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toBeInstanceOf(TranscriptionError);
  });
});
