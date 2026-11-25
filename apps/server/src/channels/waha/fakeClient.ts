import type { WhatsAppError, WhatsAppSender } from "./client.js";

/** In-memory sender for tests: records what would go to WhatsApp. */
export class FakeWhatsAppSender implements WhatsAppSender {
  sent: { to: string; text: string; options?: string[] }[] = [];
  /** Every call fails with these, in order, before succeeding again. */
  failures: WhatsAppError[] = [];
  /** Fails the next call (kept for one-off failures). */
  failNextWith?: WhatsAppError;
  private n = 0;

  private maybeFail(): void {
    const err = this.failNextWith ?? this.failures.shift();
    this.failNextWith = undefined;
    if (err) throw err;
  }

  async sendText(to: string, text: string): Promise<{ id: string }> {
    this.maybeFail();
    this.sent.push({ to, text });
    return { id: `fake-${++this.n}` };
  }

  async sendChoices(to: string, text: string, options: string[]): Promise<{ id: string }> {
    this.maybeFail();
    this.sent.push({ to, text, options });
    return { id: `fake-${++this.n}` };
  }
}
