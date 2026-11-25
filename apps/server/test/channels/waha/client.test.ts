import { describe, expect, it } from "vitest";
import { WhatsAppError, createWahaLidResolver, createWahaSender, listTitleAndBody, verifyWahaSecret } from "../../../src/channels/waha/client.js";

const KEY = "waha-key-should-never-leak";
type Call = { url: string; init: RequestInit };

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
// check-exists runs before the first send to each number.
const exists = (chatId: string) => json({ numberExists: true, chatId });

function setup(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const sender = createWahaSender({
    baseUrl: "http://localhost:3002/",
    apiKey: KEY,
    session: "default",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no more fake responses");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  });
  return { sender, calls };
}
const body = (c: Call) => JSON.parse(String(c.init.body));
const header = (c: Call, k: string) => new Headers(c.init.headers).get(k);

async function errorOf(p: Promise<unknown>): Promise<WhatsAppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WhatsAppError);
    return e as WhatsAppError;
  }
  throw new Error("expected rejection");
}

describe("createWahaSender", () => {
  it("Review Focus 4: sends to the chatId WAHA reports (old number without the ninth digit), with the key", async () => {
    const { sender, calls } = setup([exists("558699998888@c.us"), json({ id: "true_558699998888@c.us_ABC" })]);
    expect(await sender.sendText("5586999998888", "oi")).toEqual({ id: "true_558699998888@c.us_ABC" });
    expect(calls[0]!.url).toBe("http://localhost:3002/api/contacts/check-exists?phone=5586999998888&session=default");
    expect(header(calls[0]!, "X-Api-Key")).toBe(KEY);
    expect(calls[1]!.url).toBe("http://localhost:3002/api/sendText");
    expect(header(calls[1]!, "X-Api-Key")).toBe(KEY);
    expect(body(calls[1]!)).toEqual({ session: "default", chatId: "558699998888@c.us", text: "oi" });
  });

  it("caches the chatId: a second send to the same number does not check again", async () => {
    const { sender, calls } = setup([exists("558699998888@c.us"), json({ id: "a" }), json({ id: "b" })]);
    await sender.sendText("558699998888", "1");
    await sender.sendText("558699998888", "2");
    expect(calls.map((c) => c.url.split("/api/")[1])).toEqual([
      "contacts/check-exists?phone=558699998888&session=default",
      "sendText",
      "sendText",
    ]);
  });

  it("falls back to the number as it came when the check fails", async () => {
    const { sender, calls } = setup([json({}, 500), json({ id: "a" })]);
    await sender.sendText("5586999998888", "oi");
    expect(body(calls[1]!).chatId).toBe("5586999998888@c.us");
  });

  it("reads the sent message id in WAHA's different shapes, or makes one up", async () => {
    const { sender } = setup([exists("1@c.us"), json({ id: { _serialized: "x1" } }), json({ _data: { id: { _serialized: "x2" } } }), json({})]);
    expect((await sender.sendText("5586999998888", "a")).id).toBe("x1");
    expect((await sender.sendText("5586999998888", "b")).id).toBe("x2");
    expect((await sender.sendText("5586999998888", "c")).id).toMatch(/^waha\./);
  });

  it("sends choices as a WAHA list with one row per option", async () => {
    const { sender, calls } = setup([exists("5586999998888@c.us"), json({ id: "l1" })]);
    await sender.sendChoices("5586999998888", "Resumo do pedido:\n• 1x GLP 13KG — R$ 150,00\nTotal: R$ 150,00", ["Confirmar", "Mudar algo"]);
    expect(calls[1]!.url).toBe("http://localhost:3002/api/sendList");
    expect(body(calls[1]!)).toEqual({
      session: "default",
      chatId: "5586999998888@c.us",
      message: {
        title: "Resumo do pedido",
        description: "• 1x GLP 13KG — R$ 150,00\nTotal: R$ 150,00",
        button: "Ver opções",
        sections: [
          {
            title: "Opções",
            rows: [
              { title: "Confirmar", rowId: "opcao_1", description: null },
              { title: "Mudar algo", rowId: "opcao_2", description: null },
            ],
          },
        ],
      },
    });
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [400, "invalid"],
    [422, "invalid"],
    [501, "unavailable"],
    [500, "server"],
    [503, "server"],
  ] as const)("maps HTTP %i to %s, without the key in the error", async (status, kind) => {
    const { sender } = setup([exists("1@c.us"), json({ message: `bad key ${KEY}` }, status)]);
    const err = await errorOf(sender.sendText("5586999998888", "oi"));
    expect(err).toMatchObject({ kind, status });
    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("maps a thrown fetch (network or timeout) to network", async () => {
    const { sender } = setup([exists("1@c.us"), new TypeError("fetch failed")]);
    expect((await errorOf(sender.sendText("5586999998888", "oi"))).kind).toBe("network");
  });
});

describe("listTitleAndBody", () => {
  it("uses the first line, without asterisks or a trailing colon, as the title", () => {
    expect(listTitleAndBody("*Resumo do pedido:*\nTotal: *R$ 1,00*")).toEqual({ title: "Resumo do pedido", description: "Total: *R$ 1,00*" });
  });

  it("never leaves the body empty", () => {
    expect(listTitleAndBody("Como prefere pagar?")).toEqual({ title: "Como prefere pagar?", description: "Toque em Ver opções para escolher." });
  });

  it("keeps a first line over 60 characters in the body, with a generic title", () => {
    const long = "x".repeat(61);
    expect(listTitleAndBody(long)).toEqual({ title: "Escolha uma opção", description: long });
  });
});

describe("createWahaLidResolver", () => {
  const mk = (responses: (Response | Error)[]) => {
    const urls: string[] = [];
    const queue = [...responses];
    const resolve = createWahaLidResolver({
      baseUrl: "http://localhost:3002",
      apiKey: KEY,
      session: "default",
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        const next = queue.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
    });
    return { resolve, urls };
  };

  it("returns only the phone digits and caches them", async () => {
    const { resolve, urls } = mk([json({ lid: "1@lid", pn: "5586999998888@c.us" })]);
    expect(await resolve("1@lid")).toBe("5586999998888");
    expect(await resolve("1@lid")).toBe("5586999998888");
    expect(urls).toEqual(["http://localhost:3002/api/default/lids/1%40lid"]);
  });

  it("returns undefined without a known phone, on an HTTP error or on a network error", async () => {
    expect(await mk([json({ lid: "1@lid", pn: null })]).resolve("1@lid")).toBeUndefined();
    expect(await mk([json({}, 404)]).resolve("1@lid")).toBeUndefined();
    expect(await mk([new TypeError("fetch failed")]).resolve("1@lid")).toBeUndefined();
  });
});

describe("verifyWahaSecret", () => {
  it("accepts only the exact secret", () => {
    expect(verifyWahaSecret("abc", "abc")).toBe(true);
    expect(verifyWahaSecret("abd", "abc")).toBe(false);
    expect(verifyWahaSecret("abcd", "abc")).toBe(false);
    expect(verifyWahaSecret("", "abc")).toBe(false);
    expect(verifyWahaSecret(undefined, "abc")).toBe(false);
  });
});
