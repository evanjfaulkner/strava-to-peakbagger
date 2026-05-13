import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOG_RING_MAX,
  clearLog,
  getRecentLog,
  log,
} from "../lib/log";
import { installFakeChromeStorage } from "./fakeChromeStorage";

beforeEach(() => {
  installFakeChromeStorage();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("log + getRecentLog", () => {
  it("round-trips an entry", async () => {
    await log("info", "hello", { foo: 1 });

    const entries = await getRecentLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      msg: "hello",
      ctx: { foo: 1 },
    });
    expect(typeof entries[0]?.t).toBe("number");
  });

  it("caps the ring at LOG_RING_MAX entries", async () => {
    // Write a few more than the cap; assert we end with exactly LOG_RING_MAX.
    const N = LOG_RING_MAX + 50;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < N; i++) writes.push(log("info", `m${i}`));
    await Promise.all(writes);

    const entries = await getRecentLog(LOG_RING_MAX + 100);
    expect(entries).toHaveLength(LOG_RING_MAX);
    // Should retain the most recent entries — last write is "m{N-1}".
    expect(entries[entries.length - 1]?.msg).toBe(`m${N - 1}`);
  });

  it("clearLog empties the ring", async () => {
    await log("warn", "x");
    expect(await getRecentLog()).toHaveLength(1);

    await clearLog();
    expect(await getRecentLog()).toEqual([]);
  });
});
