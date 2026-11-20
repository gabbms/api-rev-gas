import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Catalog } from "../catalog/catalog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { messages, orderDrafts } from "../db/schema.js";
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
    const result = buildDraft(input, await this.catalog.list(), customerId, this.cfg.maxItemQuantity);
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
    try {
      const sale = await this.revgas.createSale(payload);
      await this.finish(draft.id, { status: "created", revgasSaleId: sale.id });
      return { kind: "created", saleId: sale.id };
    } catch (e) {
      // Only errors where RevGás clearly did not create the sale are "rejected".
      if (e instanceof RevgasError && e.kind !== "server" && e.kind !== "network") {
        await this.finish(draft.id, { status: "failed", errorMessage: e.message });
        return { kind: "rejected", message: e.message };
      }
      const message = e instanceof Error ? e.message : String(e);
      await this.finish(draft.id, { status: "uncertain", errorMessage: message });
      return { kind: "uncertain" };
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
