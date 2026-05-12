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
    <button id="refresh-btn" type="button">Refresh</button>
  </header>
  <p id="cid-warning" class="warning" role="status" hidden>warning</p>
  <p id="status" role="status"></p>
  <ul id="activity-list"></ul>
  <p id="empty-state" class="empty" hidden>empty</p>
`;

function makeActivity(
  id: number,
  start: string,
  sportType: string,
  name: string,
): ActivitySummary {
  return {
    id,
    start,
    startLocal: start,
    tz: "UTC",
    name,
    sportType,
    distanceM: 1000,
    elevGainM: 100,
  };
}

let storage: ReturnType<typeof installFakeChromeStorage>;
let sendMessage: Mock;

beforeEach(() => {
  storage = installFakeChromeStorage();
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
    const openBtns = document.querySelectorAll(".open-btn");
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

describe("popup — Refresh button", () => {
  it("calls refreshActivities and re-fetches the list", async () => {
    // First response: getActivities (init). Then refreshActivities. Then getActivities (post-refresh).
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: true, count: 5 })
      .mockResolvedValueOnce({
        ok: true,
        activities: [makeActivity(1, "2026-05-08T17:00:00Z", "Hike", "x")],
      });

    await init();
    button("refresh-btn").click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[1]![0]).toEqual({ type: "refreshActivities" });
    expect(document.querySelectorAll(".activity")).toHaveLength(1);
  });

  it("surfaces an error when refresh fails", async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, activities: [] })
      .mockResolvedValueOnce({ ok: false, error: "rate limited" })
      .mockResolvedValueOnce({ ok: true, activities: [] });

    await init();
    button("refresh-btn").click();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(document.getElementById("status")?.textContent).toContain(
      "rate limited",
    );
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
    const btn = document.querySelector<HTMLButtonElement>(".open-btn");
    if (!btn) throw new Error("no .open-btn");
    btn.click();
    return btn;
  }

  function rowStatus(): string {
    return document.querySelector(".row-status")?.textContent ?? "";
  }

  it("sends processActivity with the stravaId from data-strava-id", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 2 });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "processActivity",
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

  it('shows "No peak matches" when openedCount is 0', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, openedCount: 0 });
    clickOpen();
    await flushAsync();
    await flushAsync();

    expect(rowStatus()).toContain("No peak matches");
  });

  it("shows the error message when processActivity returns ok:false", async () => {
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
