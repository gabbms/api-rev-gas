import { describe, expect, it } from "vitest";
import { parseWahaWebhook } from "../../../src/channels/waha/webhook.js";

const msg = (payload: Record<string, unknown>, event = "message") => ({
  event,
  session: "default",
  payload: {
    id: "false_5586999998888@c.us_AAA",
    timestamp: 1793404800,
    from: "5586999998888@c.us",
    fromMe: false,
    body: "oi",
    hasMedia: false,
    ...payload,
  },
});

describe("parseWahaWebhook", () => {
  it("text → message with the sender's digits (with 55), profile name and time", () => {
    expect(parseWahaWebhook(msg({ _data: { notifyName: "Gabriel" } }))).toEqual({
      messages: [
        {
          id: "false_5586999998888@c.us_AAA",
          from: "5586999998888",
          profileName: "Gabriel",
          at: new Date(1793404800_000),
          kind: "text",
          text: "oi",
        },
      ],
      lids: [],
    });
  });

  it("GOWS: the profile name is in Info.PushName, and a list choice arrives as its row title", () => {
    const r = parseWahaWebhook(msg({ body: "Confirmar", _data: { Info: { PushName: "Ana" } } }));
    expect(r.messages[0]).toMatchObject({ profileName: "Ana", kind: "text", text: "Confirmar" });
  });

  it("without a profile name, profileName is null", () => {
    expect(parseWahaWebhook(msg({})).messages[0]!.profileName).toBeNull();
  });

  it.each([
    ["audio/ogg; codecs=opus", "[áudio]"],
    ["image/webp", "[figurinha]"],
    ["image/jpeg", "[imagem]"],
    ["video/mp4", "[vídeo]"],
    ["application/pdf", "[arquivo]"],
  ])("media %s → unsupported %s", (mimetype, text) => {
    const r = parseWahaWebhook(msg({ hasMedia: true, body: "legenda", media: { url: null, mimetype } }));
    expect(r.messages[0]).toMatchObject({ kind: "unsupported", text });
  });

  it("media without a known type, and a message without text (location, contact), are unsupported", () => {
    expect(parseWahaWebhook(msg({ hasMedia: true, media: null })).messages[0]).toMatchObject({ kind: "unsupported", text: "[arquivo]" });
    expect(parseWahaWebhook(msg({ body: "  " })).messages[0]).toMatchObject({ kind: "unsupported", text: "[mensagem sem texto]" });
  });

  it("ignores our own messages, groups, other events and malformed payloads", () => {
    const empty = { messages: [], lids: [] };
    expect(parseWahaWebhook(msg({ fromMe: true }))).toEqual(empty);
    expect(parseWahaWebhook(msg({ from: "120363@g.us" }))).toEqual(empty);
    expect(parseWahaWebhook(msg({ from: "status@broadcast" }))).toEqual(empty);
    expect(parseWahaWebhook(msg({}, "session.status"))).toEqual(empty);
    expect(parseWahaWebhook(null)).toEqual(empty);
    expect(parseWahaWebhook("lixo")).toEqual(empty);
    expect(parseWahaWebhook({ event: "message", payload: { id: 1 } })).toEqual(empty);
    expect(parseWahaWebhook(msg({ timestamp: "x" }))).toEqual(empty);
  });

  it("an @lid contact goes to lids: everything ready but the phone", () => {
    const r = parseWahaWebhook(msg({ from: "123456@lid", _data: { notifyName: "Gabriel" } }));
    expect(r.messages).toEqual([]);
    expect(r.lids).toEqual([
      {
        lid: "123456@lid",
        message: { id: "false_5586999998888@c.us_AAA", profileName: "Gabriel", at: new Date(1793404800_000), kind: "text", text: "oi" },
      },
    ]);
  });
});
