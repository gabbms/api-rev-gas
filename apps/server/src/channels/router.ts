import { eq } from "drizzle-orm";
import type { Outgoing } from "../conversations/conversationService.js";
import type { Db } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { SUMMARY_QUESTION } from "../orders/draft.js";
import { LIST_BUTTON, WhatsAppError, type WhatsAppSender } from "./waha/client.js";

/** The WhatsApp list under the official summary. The customer's tap comes back as this text. */
export const CHOICES = ["Confirmar", "Mudar algo"];
const LIST_QUESTION = `Posso registrar o pedido? Toque em *${LIST_BUTTON}* para confirmar ou mudar algo.`;

type PanelHub = { message(m: Outgoing): Promise<void>; changed(conversationId: string): void };

const retriable = (e: unknown) => e instanceof WhatsAppError && (e.kind === "network" || e.kind === "server");
const kindOf = (e: unknown) => (e instanceof WhatsAppError ? `${e.kind}${e.status ? ` ${e.status}` : ""}` : "erro inesperado");

/**
 * Where a reply goes: always to the panel; WhatsApp conversations also through WAHA, to the
 * stored address. Never throws: a failed delivery is marked on the message and the turn goes on.
 */
export function createOutgoingRouter(deps: { db: Db; hub: PanelHub; whatsapp: WhatsAppSender | null }): (m: Outgoing) => Promise<void> {
  const { db, hub, whatsapp } = deps;

  async function withRetry(send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (e) {
      if (!retriable(e)) throw e;
      await send();
    }
  }

  return async (m) => {
    await hub.message(m);
    if (!whatsapp) return;
    const [conv] = await db
      .select({ channel: conversations.channel, address: conversations.channelAddress })
      .from(conversations)
      .where(eq(conversations.id, m.conversationId));
    if (conv?.channel !== "whatsapp" || !conv.address) return;
    const to = conv.address;

    let status: "sent" | "failed" = "sent";
    try {
      if (m.kind === "summary") {
        try {
          await whatsapp.sendChoices(to, m.text.replace(SUMMARY_QUESTION, LIST_QUESTION), CHOICES);
        } catch (e) {
          // No list (engine without it, or WAHA failed): the plain summary still asks for "sim".
          console.warn(`[whatsapp] lista de opções falhou (${kindOf(e)}); resumo enviado como texto`);
          await withRetry(() => whatsapp.sendText(to, m.text));
        }
      } else {
        await withRetry(() => whatsapp.sendText(to, m.text));
      }
    } catch (e) {
      status = "failed";
      console.error(`[whatsapp] mensagem não entregue (${kindOf(e)})`);
    }
    await db.update(messages).set({ deliveryStatus: status }).where(eq(messages.id, m.messageId));
    if (status === "failed") hub.changed(m.conversationId);
  };
}
