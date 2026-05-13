// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChromeStorage } from "./fakeChromeStorage";
import type { LogEntry } from "../lib/models";

// Re-import the options init under a fresh module graph so it sees
// our installed fake-chrome BEFORE its top-level `if
// (!import.meta.env.VITEST)` skip kicks in.
const PAGE_HTML = `
  <section id="connection">
    <button id="connect-btn" type="button" disabled>Connect Strava</button>
    <p id="connect-status" role="status"></p>
    <div id="connected-block" hidden></div>
  </section>
  <form id="options-form" novalidate>
    <input id="clientId" name="clientId" type="text" />
    <input id="clientSecret" name="clientSecret" type="password" />
    <input id="climberId" name="climberId" type="text" />
    <input id="horizM" name="horizM" type="number" />
    <input id="vertM" name="vertM" type="number" />
    <input id="lookbackDays" name="lookbackDays" type="number" />
    <textarea id="blacklist"></textarea>
    <button type="submit">Save</button>
    <p id="status" role="status"></p>
  </form>
  <section id="log-section">
    <button id="refresh-log-btn" type="button">Refresh</button>
    <button id="clear-log-btn" type="button">Clear</button>
    <pre id="log-view"></pre>
  </section>
`;

let storage: ReturnType<typeof installFakeChromeStorage>;
let init: () => Promise<void>;

const SAMPLE_LOG: LogEntry[] = [
  { t: Date.parse("2026-05-13T15:00:00Z"), level: "info", msg: "first" },
  {
    t: Date.parse("2026-05-13T15:01:00Z"),
    level: "warn",
    msg: "rate limited",
    ctx: { nextRetryAt: 1234 },
  },
  {
    t: Date.parse("2026-05-13T15:02:00Z"),
    level: "error",
    msg: "boom",
  },
];

beforeEach(async () => {
  storage = installFakeChromeStorage();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = PAGE_HTML;
  const mod = await import("../entrypoints/options/main");
  init = mod.init;
});

describe("options log viewer", () => {
  it("renders recent log entries on init", async () => {
    storage.bag["log"] = SAMPLE_LOG;

    await init();

    const text = document.getElementById("log-view")?.textContent ?? "";
    expect(text).toContain("first");
    expect(text).toContain("rate limited");
    expect(text).toContain("boom");
    expect(text).toMatch(/\[info\]|\[warn\]|\[error\]/);
  });

  it("renders (empty) marker when no entries", async () => {
    await init();
    const text = document.getElementById("log-view")?.textContent ?? "";
    expect(text).toBe("(empty)");
  });

  it("Clear button empties the log", async () => {
    storage.bag["log"] = SAMPLE_LOG;
    await init();

    const clearBtn = document.getElementById(
      "clear-log-btn",
    ) as HTMLButtonElement;
    clearBtn.click();
    // wait for async then-chain
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(storage.bag["log"]).toEqual([]);
    const text = document.getElementById("log-view")?.textContent ?? "";
    expect(text).toBe("(empty)");
  });
});
