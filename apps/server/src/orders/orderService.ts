import { and, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import type { Catalog } from "../catalog/catalog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { pricingCustomer, saveProfileFromSale } from "../customers/customerProfiles.js";
import { conversations, messages, orderDrafts } from "../db/schema.js";
import { RevgasError, type RevgasClient, type RevgasSale } from "../revgas/types.js";
import { buildDraft, toSalePayload, type DraftData, type DraftInput, type DraftResult } from "./draft.js";

export type ConfirmResult =
  | { kind: "created"; saleId: number }
  | { kind: "already_created"; saleId: number }
  | { kind: "not_ready"; reason: "no_draft" | "not_presented" | "no_reply_after_summary" | "in_progress" }
  | { kind: "rejected"; message: string }
  | { kind: "uncertain" };

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

/**
 * The only place a sale is created. A sale needs: an open draft whose official summary
 * was presented, a customer message after that, and winning the open→sending transition.
 */
export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly catalog: Catalog,
    private readonly revgas: RevgasClient,
    private readonly cfg: AppConfig,
  ) {}

  /** Replaces the conversation's open draft (or creates one). Always clears presentedAt. */
  async upsertDraft(
    conversationId: string,
    input: DraftInput,
    customerId: number | null,
  ): Promise<DraftResult & { draftId?: string }> {
    // REVGAS_PRICE_PRIORITY: the Catalog decides customer > category > general for an identified customer.
    const products = await this.catalog.list(await pricingCustomer(this.db, this.cfg, customerId));
    const result = buildDraft(input, products, customerId, this.cfg.maxItemQuantity);
    if (!result.ok) return result;

    const values = {
      payload: result.data,
      totalCents: result.data.totalCents,
      summaryText: result.summaryText,
      presentedAt: null,
      updatedAt: new Date(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const [updated] = await this.db
        .update(orderDrafts)
        .set(values)
        .where(and(eq(orderDrafts.conversationId, conversationId), eq(orderDrafts.status, "open")))
        .returning({ id: orderDrafts.id });
      if (updated) return { ...result, draftId: updated.id };
      try {
        const [inserted] = await this.db
          .insert(orderDrafts)
          .values({ conversationId, status: "open", ...values })
          .returning({ id: orderDrafts.id });
        return { ...result, draftId: inserted!.id };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Another open draft appeared concurrently (retry as update) or one is being sent.
        const sending = await this.findDraft(conversationId, "sending");
        if (sending) return { ok: false, errors: ["O pedido anterior ainda está sendo registrado; aguarde um instante"] };
      }
    }
    throw new Error("Não foi possível salvar o rascunho");
  }

  async markPresented(draftId: string, at: Date): Promise<void> {
    await this.db
      .update(orderDrafts)
      .set({ presentedAt: at, updatedAt: new Date() })
      .where(and(eq(orderDrafts.id, draftId), eq(orderDrafts.status, "open")));
  }

  /** The open draft no longer counts as presented: a new summary must be sent before a "sim". */
  async clearPresentation(conversationId: string): Promise<void> {
    await this.db
      .update(orderDrafts)
      .set({ presentedAt: null, updatedAt: new Date() })
      .where(and(eq(orderDrafts.conversationId, conversationId), eq(orderDrafts.status, "open")));
  }

  async confirm(conversationId: string): Promise<ConfirmResult> {
    const draft = await this.findDraft(conversationId, "open");
    if (!draft) {
      const latest = await this.latestDraft(conversationId);
      if (latest?.status === "created" && latest.revgasSaleId !== null) {
        return { kind: "already_created", saleId: latest.revgasSaleId };
      }
      if (latest?.status === "sending") return { kind: "not_ready", reason: "in_progress" };
      return { kind: "not_ready", reason: "no_draft" };
    }

    const presentedAt = draft.presentedAt;
    if (!presentedAt) return { kind: "not_ready", reason: "not_presented" };

    const [reply] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.author, "customer"),
          gt(messages.createdAt, presentedAt),
        ),
      )
      .limit(1);
    if (!reply) return { kind: "not_ready", reason: "no_reply_after_summary" };

    // Atomic gate: only one caller moves this exact presented version to 'sending'.
    const claimed = await this.db
      .update(orderDrafts)
      .set({ status: "sending", updatedAt: new Date() })
      .where(
        and(
          eq(orderDrafts.id, draft.id),
          eq(orderDrafts.status, "open"),
          sql`${orderDrafts.presentedAt} = ${presentedAt.toISOString()}`,
        ),
      )
      .returning({ id: orderDrafts.id });
    if (claimed.length === 0) {
      const latest = await this.latestDraft(conversationId);
      if (latest?.status === "created" && latest.revgasSaleId !== null) {
        return { kind: "already_created", saleId: latest.revgasSaleId };
      }
      return { kind: "not_ready", reason: "in_progress" };
    }

    const payload = toSalePayload(draft.payload as DraftData, this.cfg.revgasEstablishmentId, this.cfg.revgasBroadcast);
    let sale: RevgasSale;
    try {
      sale = await this.revgas.createSale(payload);
    } catch (e) {
      // Only errors where RevGás clearly did not create the sale are "rejected".
      if (e instanceof RevgasError && e.kind !== "server" && e.kind !== "network") {
        await this.finishOrUncertain(draft.id, { status: "failed", errorMessage: e.message });
        return { kind: "rejected", message: e.message };
      }
      const message = e instanceof Error ? e.message : String(e);
      await this.finishOrUncertain(draft.id, { status: "uncertain", errorMessage: message });
      return { kind: "uncertain" };
    }

    try {
      await this.finish(draft.id, { status: "created", revgasSaleId: sale.id });
    } catch (e) {
      // The sale exists in RevGás but we could not record it: never leave the draft in 'sending'.
      console.error(`[pedidos] venda ${sale.id} criada, mas não foi gravada:`, e instanceof Error ? e.message : e);
      await this.finishOrUncertain(draft.id, {
        status: "uncertain",
        revgasSaleId: sale.id,
        errorMessage: `Venda ${sale.id} criada na RevGás, mas não foi gravada no sistema; conferir no ERP`,
      });
      return { kind: "uncertain" };
    }
    await this.rememberCustomer(conversationId, draft.payload as DraftData, sale.id);
    return { kind: "created", saleId: sale.id };
  }

  /**
   * On startup: a draft still in 'sending' means the process died mid-sale. RevGás may or may not
   * have the sale, so mark it uncertain and hand the conversation to a human. Returns how many.
   * There is a single server, so at startup no sale is in progress: the default limit is zero
   * (`pnpm dev` restarts within seconds on every save).
   */
  async recoverInterruptedSales(olderThanMs = 0, now = new Date()): Promise<number> {
    const stuck = await this.db
      .update(orderDrafts)
      .set({ status: "uncertain", errorMessage: "Venda possivelmente interrompida (servidor reiniciou)", updatedAt: now })
      .where(and(eq(orderDrafts.status, "sending"), lte(orderDrafts.updatedAt, new Date(now.getTime() - olderThanMs))))
      .returning({ id: orderDrafts.id, conversationId: orderDrafts.conversationId });
    for (const d of stuck) {
      await this.db
        .update(conversations)
        .set({ mode: "human", handoffReason: "Venda possivelmente interrompida; conferir no ERP", updatedAt: now })
        .where(eq(conversations.id, d.conversationId));
      console.warn(`[pedidos] rascunho ${d.id} estava em 'sending' após reinício; marcado como incerto e enviado a um atendente`);
    }
    return stuck.length;
  }

  /** Records the outcome; if even that fails, tries to at least leave 'sending' as uncertain. */
  private async finishOrUncertain(
    draftId: string,
    values: { status: "failed" | "uncertain"; revgasSaleId?: number; errorMessage?: string },
  ): Promise<void> {
    try {
      await this.finish(draftId, values);
    } catch (e) {
      console.error("[pedidos] falha ao gravar o resultado da venda:", e instanceof Error ? e.message : e);
      try {
        await this.finish(draftId, { ...values, status: "uncertain" });
      } catch {
        // Startup recovery (recoverInterruptedSales) will catch it.
      }
    }
  }

  async getLatestSale(conversationId: string): Promise<RevgasSale | null> {
    const [row] = await this.db
      .select({ saleId: orderDrafts.revgasSaleId })
      .from(orderDrafts)
      .where(and(eq(orderDrafts.conversationId, conversationId), isNotNull(orderDrafts.revgasSaleId)))
      .orderBy(desc(orderDrafts.createdAt))
      .limit(1);
    if (!row?.saleId) return null;
    return this.revgas.getSale(row.saleId);
  }

  /** C1: the sale exists in RevGás, so a profile failure must not change the result. */
  private async rememberCustomer(conversationId: string, data: DraftData, saleId: number): Promise<void> {
    try {
      const [conv] = await this.db
        .select({ phone: conversations.phone })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (conv) await saveProfileFromSale(this.db, conv.phone, data, saleId);
    } catch (e) {
      console.error("[pedidos] venda criada, mas o perfil do cliente não foi salvo:", e instanceof Error ? e.message : e);
    }
  }

  private async finish(
    draftId: string,
    values: { status: "created" | "failed" | "uncertain"; revgasSaleId?: number; errorMessage?: string },
  ): Promise<void> {
    await this.db
      .update(orderDrafts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(orderDrafts.id, draftId));
  }

  private async findDraft(conversationId: string, status: "open" | "sending") {
    const [row] = await this.db
      .select()
      .from(orderDrafts)
      .where(and(eq(orderDrafts.conversationId, conversationId), eq(orderDrafts.status, status)))
      .limit(1);
    return row;
  }

  private async latestDraft(conversationId: string) {
    const [row] = await this.db
      .select()
      .from(orderDrafts)
      .where(eq(orderDrafts.conversationId, conversationId))
      .orderBy(desc(orderDrafts.createdAt))
      .limit(1);
    return row;
  }
}
