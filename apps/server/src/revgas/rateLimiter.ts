const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs scheduled calls one at a time, keeping at least `minIntervalMs` between the
 * start of consecutive calls. A single instance must be shared by every RevGás call.
 */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart: number | null = null;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.lastStart !== null) {
        const wait = this.lastStart + this.minIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart = this.now();
      return fn();
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
