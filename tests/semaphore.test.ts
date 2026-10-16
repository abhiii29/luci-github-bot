import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({ getConfig: () => ({}) }));
const { DynamicSemaphore } = await import("../src/docker-worker.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DynamicSemaphore", () => {
  it("limits concurrency to max", async () => {
    const s = new DynamicSemaphore(2);
    await s.acquire();
    await s.acquire();
    let third = false;
    void s.acquire().then(() => (third = true));
    await tick();
    expect(third).toBe(false);
    s.release();
    await tick();
    expect(third).toBe(true);
    expect(s.getAvailable()).toBe(0);
  });

  it("recovers slots after resource pressure ends (permits were lost forever before)", async () => {
    const s = new DynamicSemaphore(2);
    s.adjustByCapacity(0); // pressure
    expect(s.getAvailable()).toBe(0);
    let got = false;
    void s.acquire().then(() => (got = true));
    await tick();
    expect(got).toBe(false);
    s.adjustByCapacity(1); // pressure gone
    await tick();
    expect(got).toBe(true);
    expect(s.getAvailable()).toBe(1);
  });

  it("lowering the limit does not over-admit when work finishes", async () => {
    const s = new DynamicSemaphore(2);
    await s.acquire();
    await s.acquire();
    s.adjustByCapacity(0.5); // limit 1, 2 in use
    let waiter = false;
    void s.acquire().then(() => (waiter = true));
    s.release(); // 1 in use, limit 1 -> still full
    await tick();
    expect(waiter).toBe(false);
    s.release();
    await tick();
    expect(waiter).toBe(true);
  });

  it("a burst of wake-ups never exceeds the limit", async () => {
    const s = new DynamicSemaphore(3);
    s.adjustByCapacity(0);
    let admitted = 0;
    for (let i = 0; i < 5; i++) void s.acquire().then(() => admitted++);
    s.adjustByCapacity(1);
    await tick();
    expect(admitted).toBe(3);
  });
});
