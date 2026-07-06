// @vitest-environment happy-dom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Mock } from "vitest";
import { init } from "../entrypoints/popup/main";
import type { ActivitySummary } from "../lib/models";
import { installFakeChromeStorage } from "./fakeChromeStorage";

const PAGE_HTML = `
  <header>
    <h1>Strava → Peakbagger</h1>
    <div class="header-actions">
      <label class="show-hidden-toggle">
        <input id="show-hidden" type="checkbox" />
        Show hidden
      </label>
      <button id="hide-all-btn" type="button">Hide all</button>
      <button id="refresh-btn" type="button">Find next match</button>
    </div>
  </header>
  <p id="cid-warning" class="warning" role="status" hidden>warning</p>
  <p id="status" role="status"></p>
  <p id="match-progress" role="status"></p>
  <ul id="activity-list"></ul>
  <p id="empty-state" class="empty" hidden>empty</p>
`;

function makeActivity(
  id: number,
  start: string,
  sportType: string,
  name: string,
  extras: {
    state?: "unmatched" | "no-match" | "pending" | "done" | "hidden";
    matchedPeakIds?: number[];
    processedPeakIds?: number[];
  } = {},
): ActivitySummary & {
  state?: string;
  matchedPeakIds?: number[];
  processedPeakIds?: number[];
} {
  return {
    id,
    start,
    startLocal: start,
    tz: "UTC",
    name,
    sportType,
    distanceM: 1000,
    elevGainM: 100,
    ...extras,
  };
}

let storage: ReturnType<typeof installFakeChromeStorage>;
let sendMessage: Mock;

beforeEach(() => {
  storage = installFakeChromeStorage();
  // Seed today's matchSession so the v0.2 auto-trigger doesn't fire
  // for existing tests (each explicit auto-trigger test clears this).
  const today = new Date().toLocaleDateString("sv-SE");
  storage.bag["matchSession"] = {
    lastAutoRefreshDay: today,
    lastBatchEndIndex: 0,
  };
  sendMessage = vi.fn();
  // Override the fake's sendMessage so each test controls responses.
  (globalThis as unknown as { chrome: { runtime: { sendMessage: Mock } } }).chrome.runtime.sendMessage =
    sendMessage;
  document.body.innerHTML = PAGE_HTML;
});

function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function button(id: string): HTMLButtonElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`#${id} missing`);
  return node;
}

describe("popup init — cid warning", () => {
  it("shows the cid warning when climberId is not set", async () => {
    sendMessage.mockResolvedValue({ ok: true, activities: [] });
    await init();
    expect(document.getElementById("cid-warning")?.hidden).toBe(false);
  });

  it("hides the cid warning when climberId is set", async () => {
    storage.bag["pb"] = { climberId: 42 };
    sendMessage.mockResolvedValue({ ok: true, activities: [] });
    await init();
    expect(document.getElementById("cid-warning")?.hidden).toBe(true);
  });
});

describe("popup init — activity list rendering", () => {
  it("shows the empty state when getActivities returns []", async () => {
    sendMessage.mockResolvedValue({ ok: true, activities: [] });
    await init();
    expect(document.getElementById("empty-state")?.hidden).toBe(false);
    expect(document.querySelectorAll(".activity")).toHaveLength(0);
  });

  it("renders one row per activity with the correct data-strava-id", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "Mt Tam loop"),
        makeActivity(102, "2026-05-07T17:00:00Z", "Run", "River trail"),
      ],
    });

    await init();

    const rows = document.querySelectorAll(".activity");
    expect(rows).toHaveLength(2);
    const openBtns = document.querySelectorAll(".log-btn");
    expect((openBtns[0] as HTMLButtonElement).dataset["stravaId"]).toBe("101");
    expect((openBtns[1] as HTMLButtonElement).dataset["stravaId"]).toBe("102");
    expect(rows[0]!.textContent).toContain("2026-05-08");
    expect(rows[0]!.textContent).toContain("Hike");
    expect(rows[0]!.textContent).toContain("Mt Tam loop");
    expect(document.getElementById("empty-state")?.hidden).toBe(true);
  });

  it("surfaces an error when getActivities returns ok:false", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "kaboom" });
    await init();
    const status = document.getElementById("status")?.textContent ?? "";
    expect(status).toContain("kaboom");
  });
});

describe("popup — Find next match button", () => {
  it("refreshes the list, then runs matchBatch from index 0", async () => {
    // init getActivities → refreshActivities → getActivities (render) → matchBatch.
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: true, count: 5 })
      .mockResolvedValueOnce({
        ok: true,
        activities: [makeActivity(1, "2026-05-08T17:00:00Z", "Hike", "x")],
      })
      .mockResolvedValueOnce({
        ok: true,
        reason: "found-pending",
        endIndex: 1,
      });

    await init();
    button("refresh-btn").click();
    await flushAsync();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const calls = sendMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls[1]).toEqual({ type: "refreshActivities" });
    expect(calls).toContainEqual({
      type: "matchBatch",
      startIndex: 0,
      size: 20,
      autoContinue: true,
    });
    expect(document.querySelectorAll(".activity")).toHaveLength(1);
  });

  it("scans from 0 even when a cursor was previously advanced", async () => {
    // A stale cursor must NOT cause a from-cursor scan — new activities
    // sort to the top (index 0) and would be skipped otherwise.
    storage.bag["matchSession"] = {
      lastAutoRefreshDay: new Date().toLocaleDateString("sv-SE"),
      lastBatchEndIndex: 47,
    };
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: true, count: 1 })
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: true, reason: "exhausted", endIndex: 1 });

    await init();
    button("refresh-btn").click();
    await flushAsync();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const matchCall = sendMessage.mock.calls
      .map((c: unknown[]) => c[0] as { type?: string; startIndex?: number })
      .find((c) => c.type === "matchBatch");
    expect(matchCall?.startIndex).toBe(0);
  });

  it("surfaces an error when refresh fails and does not run matchBatch", async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: false, error: "rate limited" });

    await init();
    button("refresh-btn").click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(document.getElementById("status")?.textContent).toContain(
      "rate limited",
    );
    const types = sendMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    expect(types).not.toContain("matchBatch");
    // Button re-enabled for another attempt.
    expect(button("refresh-btn").disabled).toBe(false);
  });
});

describe("popup — Open button", () => {
  beforeEach(async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "Test")],
    });
    await init();
    sendMessage.mockReset();
  });

  function clickOpen(): HTMLButtonElement {
    const btn = document.querySelector<HTMLButtonElement>(".log-btn");
    if (!btn) throw new Error("no .log-btn");
    btn.click();
    return btn;
  }

  function rowStatus(): string {
    return document.querySelector(".row-status")?.textContent ?? "";
  }

  it("sends logAscents with the stravaId from data-strava-id", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 2 });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "logAscents",
      stravaId: 101,
    });
  });

  it('shows "Opened N tabs" on success', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 2 });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(rowStatus()).toContain("Opened 2 tab");
  });

  it("shows sequential copy for multi-peak (v0.3)", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      openedCount: 1,
      totalMatches: 3,
      sequential: true,
    });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(rowStatus()).toBe("Saving 1/3 (more open as you save)");
  });

  it('shows "No peak matches" when openedCount is 0', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 0 });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(rowStatus()).toContain("No peak matches");
  });

  it("shows the error message when logAscents returns ok:false", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: "Activity not in cache — click Refresh first",
    });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(rowStatus()).toContain("Refresh first");
  });

  it("disables the Open button while processing", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 1 });
    const btn = clickOpen();

    // Disabled synchronously when click handler fires.
    expect(btn.disabled).toBe(true);

    await flushAsync();
    await flushAsync();

    // Re-enabled after the response resolves.
    expect(btn.disabled).toBe(false);
  });
});

describe("popup — idempotency UI", () => {
  it("renders a (M/N) badge on pending rows", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "Traverse", {
          state: "pending",
          matchedPeakIds: [1, 2, 3],
          processedPeakIds: [1],
        }),
      ],
    });

    await init();

    const badge = document.querySelector(".match-badge");
    expect(badge?.textContent ?? "").toMatch(/1\s*\/\s*3/);
  });

  it('done rows render an "Unhide" button (only visible under Show hidden)', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "Done one", {
          state: "done",
          matchedPeakIds: [1],
          processedPeakIds: [1],
        }),
      ],
    });

    await init();

    expect(document.querySelector(".activity.done")).not.toBeNull();
    expect(document.querySelector(".unhide-btn")).not.toBeNull();
    expect(document.querySelector(".log-btn")).toBeNull();
  });

  it("unmatched and pending rows have a Hide button", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      activities: [
        makeActivity(1, "2026-05-08T17:00:00Z", "Hike", "U", {
          state: "unmatched",
        }),
        makeActivity(2, "2026-05-07T17:00:00Z", "Run", "P", {
          state: "pending",
          matchedPeakIds: [10],
          processedPeakIds: [],
        }),
      ],
    });

    await init();

    expect(document.querySelectorAll(".hide-btn")).toHaveLength(2);
    expect(document.querySelectorAll(".unhide-btn")).toHaveLength(0);
  });

  it("toggling Show hidden sends getActivities with showHidden=true", async () => {
    // First call: init renders with showHidden=false
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    await init();

    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: "getActivities",
      showHidden: false,
    });

    // Toggle: second getActivities should go with showHidden=true
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    const toggle = document.getElementById("show-hidden") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsync();
    await flushAsync();

    expect(sendMessage.mock.calls[1]![0]).toEqual({
      type: "getActivities",
      showHidden: true,
    });
  });

  it("clicking Hide sends markActivityHidden and re-fetches the list", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "T", {
          state: "pending",
          matchedPeakIds: [1, 2],
          processedPeakIds: [],
        }),
      ],
    });
    await init();
    sendMessage.mockReset();

    sendMessage
      .mockResolvedValueOnce({ ok: true, hiddenCount: 2 })
      .mockResolvedValueOnce({ ok: true, activities: [] });

    const hideBtn = document.querySelector<HTMLButtonElement>(".hide-btn")!;
    hideBtn.click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: "markActivityHidden",
      stravaId: 101,
    });
    // Second call: getActivities re-fetch after the Hide succeeds.
    expect(sendMessage.mock.calls[1]![0]).toMatchObject({
      type: "getActivities",
    });
  });

  it("clicking Unhide sends markActivityUnhidden", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "D", {
          state: "done",
          matchedPeakIds: [1],
          processedPeakIds: [1],
        }),
      ],
    });
    await init();
    sendMessage.mockReset();

    sendMessage
      .mockResolvedValueOnce({ ok: true, unhiddenCount: 1 })
      .mockResolvedValueOnce({ ok: true, activities: [] });

    const unhideBtn = document.querySelector<HTMLButtonElement>(".unhide-btn")!;
    unhideBtn.click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: "markActivityUnhidden",
      stravaId: 101,
    });
  });

  it('shows "All matches already saved" when totalMatches > 0 but openedCount = 0', async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "T", {
          state: "pending",
          matchedPeakIds: [1, 2],
          processedPeakIds: [1, 2],
        }),
      ],
    });
    await init();

    sendMessage.mockResolvedValueOnce({
      ok: true,
      openedCount: 0,
      totalMatches: 2,
    });

    const openBtn = document.querySelector<HTMLButtonElement>(".log-btn")!;
    openBtn.click();
    await flushAsync();
    await flushAsync();

    const status = document.querySelector(".row-status")?.textContent ?? "";
    expect(status).toContain("already saved");
  });

  it("Hide all button sends hideAllVisible and re-fetches", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "T", {
          state: "unmatched",
        }),
      ],
    });
    await init();
    sendMessage.mockReset();
    sendMessage
      .mockResolvedValueOnce({ ok: true, hiddenCount: 1 })
      .mockResolvedValueOnce({ ok: true, activities: [] });

    const btn = document.getElementById("hide-all-btn") as HTMLButtonElement;
    btn.click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(sendMessage.mock.calls[0]![0]).toEqual({ type: "hideAllVisible" });
    expect(sendMessage.mock.calls[1]![0]).toMatchObject({
      type: "getActivities",
    });
    expect(document.getElementById("status")?.textContent).toContain("Hid 1");
  });

  it("renders Strava rate-limit errors as a local time", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      activities: [
        makeActivity(101, "2026-05-08T17:00:00Z", "Hike", "T", {
          state: "pending",
          matchedPeakIds: [1],
          processedPeakIds: [],
        }),
      ],
    });
    await init();

    // pick a near-future iso timestamp; assert the popup formats HH:MM
    const tomorrow = new Date(Date.now() + 60_000);
    const iso = tomorrow.toISOString();
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: `Strava rate limit reached; retry after ${iso}`,
    });

    const openBtn = document.querySelector<HTMLButtonElement>(".log-btn")!;
    openBtn.click();
    await flushAsync();
    await flushAsync();

    const status = document.querySelector(".row-status")?.textContent ?? "";
    expect(status).toContain("Rate limited");
    const hh = String(tomorrow.getHours()).padStart(2, "0");
    const mm = String(tomorrow.getMinutes()).padStart(2, "0");
    expect(status).toContain(`${hh}:${mm}`);
  });
});

describe("popup — v0.2 streaming + auto-trigger", () => {
  // Helper: capture the chrome.runtime.onMessage listener so tests
  // can fire matchBatch:item / :done events at the popup.
  let onMessageCb: ((msg: unknown) => void) | null = null;

  beforeEach(() => {
    onMessageCb = null;
    (globalThis as unknown as {
      chrome: {
        runtime: { onMessage: { addListener: (cb: typeof onMessageCb) => void } };
      };
    }).chrome.runtime.onMessage = {
      addListener: (cb) => {
        onMessageCb = cb;
      },
    };
  });

  function fireBatchEvent(msg: unknown): void {
    if (onMessageCb) onMessageCb(msg);
  }

  it("auto-trigger fires when matchSession.lastAutoRefreshDay is not today", async () => {
    // Replace the today-seed with yesterday.
    storage.bag["matchSession"] = {
      lastAutoRefreshDay: "1999-01-01",
      lastBatchEndIndex: 0,
    };
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] }) // initial getActivities
      .mockResolvedValueOnce({ ok: true, count: 3 }) // refreshActivities
      .mockResolvedValueOnce({ ok: true, sessionId: "x", totalScanned: 0, totalMatches: 0, endIndex: 0, reason: "exhausted" }); // matchBatch

    await init();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const types = sendMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    expect(types).toContain("refreshActivities");
    expect(types).toContain("matchBatch");
  });

  it("auto-trigger does NOT fire when lastAutoRefreshDay is today", async () => {
    // beforeEach already seeded today.
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });

    await init();
    await flushAsync();

    // Only the initial getActivities call should have fired.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: "getActivities",
      showHidden: false,
    });
  });

  it('matchBatch:item with addedPendingRow=true updates the cumulative counter and re-renders', async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] }) // init render
      .mockResolvedValueOnce({
        ok: true,
        activities: [
          makeActivity(42, "2026-05-13T10:00:00Z", "Hike", "T", {
            state: "pending",
            matchedPeakIds: [1],
            processedPeakIds: [],
          }),
        ],
      }); // re-render after the event

    await init();
    await flushAsync();

    fireBatchEvent({
      type: "matchBatch:item",
      sessionId: "x",
      stravaId: 42,
      peakCount: 1,
      addedPendingRow: true,
      totalScanned: 1,
    });
    await flushAsync();
    await flushAsync();

    const progress = document.getElementById("match-progress")?.textContent ?? "";
    expect(progress).toContain("Scanned 1");
    expect(progress).toContain("Found 1 match");
    // Activity row appears via re-render.
    expect(document.querySelectorAll(".activity")).toHaveLength(1);
  });

  it('matchBatch:item with addedPendingRow=false increments counters but no re-render', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    await init();
    await flushAsync();
    sendMessage.mockReset();

    fireBatchEvent({
      type: "matchBatch:item",
      sessionId: "x",
      stravaId: 42,
      peakCount: 0,
      addedPendingRow: false,
      totalScanned: 1,
    });
    await flushAsync();

    // No additional getActivities re-fetch should have fired.
    expect(sendMessage).not.toHaveBeenCalled();
    const progress = document.getElementById("match-progress")?.textContent ?? "";
    expect(progress).toContain("Scanned 1");
    expect(progress).toContain("Found 0 matches");
  });

  it('matchBatch:done with reason=exhausted re-enables the button and reports all caught up', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    await init();
    await flushAsync();

    fireBatchEvent({
      type: "matchBatch:done",
      sessionId: "x",
      totalScanned: 5,
      totalMatches: 0,
      endIndex: 5,
      reason: "exhausted",
    });
    await flushAsync();
    await flushAsync();

    const btn = document.getElementById("refresh-btn") as HTMLButtonElement;
    // Stays live: a later sync may add new activities to find.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Find next match");
    expect(document.getElementById("status")?.textContent).toContain(
      "all caught up",
    );
  });

  it('matchBatch:done with reason=found-pending re-enables the button', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    await init();
    await flushAsync();

    fireBatchEvent({
      type: "matchBatch:done",
      sessionId: "x",
      totalScanned: 2,
      totalMatches: 1,
      endIndex: 2,
      reason: "found-pending",
    });
    await flushAsync();
    await flushAsync();

    const btn = document.getElementById("refresh-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Find next match");
  });

  it('matchBatch:done with reason=rate-limited shows cooldown text on the button', async () => {
    storage.sessionBag["stravaNextRetryAt"] = Date.now() + 60 * 60 * 1000;
    sendMessage.mockResolvedValueOnce({ ok: true, activities: [] });
    await init();
    await flushAsync();

    fireBatchEvent({
      type: "matchBatch:done",
      sessionId: "x",
      totalScanned: 3,
      totalMatches: 1,
      endIndex: 3,
      reason: "rate-limited",
    });
    await flushAsync();
    await flushAsync();

    const btn = document.getElementById("refresh-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Rate limited.*\d{2}:\d{2}/);
  });
});
