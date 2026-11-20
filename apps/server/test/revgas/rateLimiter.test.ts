import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/revgas/rateLimiter.js";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("RateLimiter", () => {
  it("starts three simultaneous calls at t=0, 1000 and 2000", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);
    const starts: number[] = [];
    const call = () => limiter.schedule(async () => void starts.push(clock.now()));
    await Promise.all([call(), call(), call()]);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("keeps going after a call rejects", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);
    const failing = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const next = limiter.schedule(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("returns each result to its own caller", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);
    const results = await Promise.all([1, 2, 3].map((n) => limiter.schedule(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });

  it("does not wait when enough time has passed since the last start", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);
    await limiter.schedule(async () => undefined);
    await clock.sleep(5000);
    const before = clock.now();
    await limiter.schedule(async () => undefined);
    expect(clock.now()).toBe(before);
  });
});
