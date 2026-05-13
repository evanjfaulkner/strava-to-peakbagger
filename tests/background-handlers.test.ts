import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ActivitySummary } from "../lib/models";
import { installFakeChromeStorage } from "./fakeChromeStorage";

// WXT auto-import shim — must be in place before importing
// background.ts (which calls defineBackground at module top level).
(globalThis as unknown as { defineBackground: (c: unknown) => unknown }).defineBackground =
  (config) => config;

let handleGetActivities: typeof import("../entrypoints/background").handleGetActivities;
let handleRefreshActivities: typeof import("../entrypoints/background").handleRefreshActivities;
let handleProcessActivity: typeof import("../entrypoints/background").handleProcessActivity;
let handleAscentSaved: typeof import("../entrypoints/background").handleAscentSaved;
let handleMarkActivityHidden: typeof import("../entrypoints/background").handleMarkActivityHidden;
let handleMarkActivityUnhidden: typeof import("../entrypoints/background").handleMarkActivityUnhidden;
let handleHideAllVisible: typeof import("../entrypoints/background").handleHideAllVisible;
let handleGetTabMapping: typeof import("../entrypoints/background").handleGetTabMapping;
let handleMatchBatch: typeof import("../entrypoints/background").handleMatchBatch;
let runWatchdog: typeof import("../entrypoints/background").runWatchdog;

beforeAll(async () => {
  const mod = await import("../entrypoints/background");
  handleGetActivities = mod.handleGetActivities;
  handleRefreshActivities = mod.handleRefreshActivities;
  handleProcessActivity = mod.handleProcessActivity;
  handleAscentSaved = mod.handleAscentSaved;
  handleMarkActivityHidden = mod.handleMarkActivityHidden;
  handleMarkActivityUnhidden = mod.handleMarkActivityUnhidden;
  handleHideAllVisible = mod.handleHideAllVisible;
  handleGetTabMapping = mod.handleGetTabMapping;
  handleMatchBatch = mod.handleMatchBatch;
  runWatchdog = mod.runWatchdog;
});

const FAR_FUTURE = 9_999_999_999;
const FAKE_ACTIVITY: ActivitySummary = {
  id: 12345678901,
  start: "2026-04-15T17:00:00Z",
  startLocal: "2026-04-15T10:00:00",
  tz: "America/Los_Angeles",
  name: "Test Hike",
  sportType: "Hike",
  distanceM: 8000,
  elevGainM: 600,
};

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(async () => {
  storage = installFakeChromeStorage();
  // Seed valid Strava tokens so getValidAccessToken short-circuits
  // without network during processActivity tests.
  storage.bag["strava"] = {
    clientId: "cid",
    clientSecret: "secret",
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: FAR_FUTURE,
    athleteId: 1,
  };
  // Peakbagger uses an in-memory token bucket that's module-scoped;
  // reset between tests so cross-test state doesn't trigger waits.
  const { _resetTokenBucketForTesting } = await import("../lib/peakbagger");
  _resetTokenBucketForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

describe("handleGetActivities", () => {
  it("returns an empty list when storage.activities is unset", async () => {
    const res = await handleGetActivities();
    expect(res).toEqual({ ok: true, activities: [] });
  });

  it("returns cached activities tagged as unmatched when no match cache", async () => {
    storage.bag["activities"] = [FAKE_ACTIVITY];
    const res = await handleGetActivities();
    expect(res).toEqual({
      ok: true,
      activities: [{ ...FAKE_ACTIVITY, state: "unmatched" }],
    });
  });

  it("filters out done activities by default", async () => {
    const otherActivity = { ...FAKE_ACTIVITY, id: 222, name: "Pending Hike" };
    storage.bag["activities"] = [FAKE_ACTIVITY, otherActivity];
    storage.bag["activityMatches"] = {
      [FAKE_ACTIVITY.id]: { peakIds: [1], computedAt: 0 },
      [otherActivity.id]: { peakIds: [10, 11], computedAt: 0 },
    };
    storage.bag["processed"] = {
      [`${FAKE_ACTIVITY.id}:1`]: { processedAt: 0, ascentId: 5 },
      [`${otherActivity.id}:10`]: { processedAt: 0, ascentId: 6 },
      // otherActivity:11 NOT processed → still pending
    };

    const res = await handleGetActivities();
    if (!res.ok) throw new Error("expected ok");

    const ids = res.activities.map((a) => a.id);
    expect(ids).toEqual([222]); // only the pending one
    expect(res.activities[0]?.state).toBe("pending");
    expect(res.activities[0]?.processedPeakIds).toEqual([10]);
    expect(res.activities[0]?.matchedPeakIds).toEqual([10, 11]);
  });

  it("with showHidden=true returns done activities too", async () => {
    storage.bag["activities"] = [FAKE_ACTIVITY];
    storage.bag["activityMatches"] = {
      [FAKE_ACTIVITY.id]: { peakIds: [1], computedAt: 0 },
    };
    storage.bag["processed"] = {
      [`${FAKE_ACTIVITY.id}:1`]: { processedAt: 0, ascentId: 5 },
    };

    const res = await handleGetActivities(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.activities).toHaveLength(1);
    expect(res.activities[0]?.state).toBe("done");
  });

  it('tags an unmatched-but-hidden activity as state "hidden" and excludes it from the default view', async () => {
    storage.bag["activities"] = [FAKE_ACTIVITY];
    storage.bag["hiddenActivities"] = { [FAKE_ACTIVITY.id]: { hiddenAt: 1 } };

    const defaultRes = await handleGetActivities();
    if (!defaultRes.ok) throw new Error("expected ok");
    expect(defaultRes.activities).toHaveLength(0);

    const fullRes = await handleGetActivities(true);
    if (!fullRes.ok) throw new Error("expected ok");
    expect(fullRes.activities).toHaveLength(1);
    expect(fullRes.activities[0]?.state).toBe("hidden");
  });
});

describe("handleRefreshActivities", () => {
  it("invokes Strava list endpoint and returns the count", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse([
          {
            id: 1,
            name: "Test",
            distance: 100,
            total_elevation_gain: 10,
            sport_type: "Hike",
            start_date: "2026-04-15T17:00:00Z",
            start_date_local: "2026-04-15T10:00:00",
            timezone: "(GMT-08:00) America/Los_Angeles",
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleRefreshActivities();
    expect(res).toEqual({ ok: true, count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleProcessActivity — error paths", () => {
  it("rejects with an Invalid stravaId message for NaN", async () => {
    storage.bag["pb"] = { climberId: 99 };
    const res = await handleProcessActivity(Number("not-a-number"));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/Invalid stravaId/);
  });

  it("surfaces a clear error when cid is unset", async () => {
    const res = await handleProcessActivity(12345);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/climber ID/);
    expect(storage.tabsCreated).toEqual([]);
  });

  it("surfaces a Refresh-first error when the activity isn't cached", async () => {
    storage.bag["pb"] = { climberId: 99 };
    const res = await handleProcessActivity(99999);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/Refresh/);
  });
});

describe("handleProcessActivity — pipeline", () => {
  const PEAK_LAT = 37.7;
  const PEAK_LNG = -122.4;
  const PEAK_ID = 4242;
  const PEAK_XML = `<ts><t i="${PEAK_ID}" a="${PEAK_LAT}" o="${PEAK_LNG}" n="Test Peak"/></ts>`;

  // Streams response that summits the peak (track point right at peak).
  const STREAMS_BODY = {
    latlng: {
      data: [
        [37.6, -122.4],
        [PEAK_LAT, PEAK_LNG],
        [37.8, -122.4],
      ],
    },
    altitude: { data: [1000, 1500, 1200] },
    time: { data: [0, 1800, 3600] },
  };

  function mockPipeline(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/streams")) {
        return Promise.resolve(jsonResponse(STREAMS_BODY));
      }
      if (url.includes("PLLBB.aspx")) {
        return Promise.resolve(xmlResponse(PEAK_XML));
      }
      if (url.includes("/api/v3/activities/")) {
        return Promise.resolve(jsonResponse({ timezone: FAKE_ACTIVITY.tz }));
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    storage.bag["pb"] = { climberId: 99 };
    storage.bag["activities"] = [FAKE_ACTIVITY];
    storage.bag["settings"] = {
      horizM: 75,
      vertM: 25,
      lookbackDays: 90,
      blacklist: [],
    };
  });

  it("opens one tab per match and writes prefill payloads", async () => {
    mockPipeline();

    const res = await handleProcessActivity(FAKE_ACTIVITY.id);

    expect(res).toEqual({
      ok: true,
      openedCount: 1,
      totalMatches: 1,
    });
    expect(storage.tabsCreated).toHaveLength(1);
    const payloads = storage.bag["prefillPayloads"] as Record<string, unknown>;
    expect(Object.keys(payloads)).toEqual([`${FAKE_ACTIVITY.id}:${PEAK_ID}`]);
  });

  it("caches activityMatches with the matched peakIds", async () => {
    mockPipeline();

    await handleProcessActivity(FAKE_ACTIVITY.id);

    const cache = storage.bag["activityMatches"] as Record<
      number,
      { peakIds: number[]; computedAt: number }
    >;
    expect(cache[FAKE_ACTIVITY.id]?.peakIds).toEqual([PEAK_ID]);
    expect(cache[FAKE_ACTIVITY.id]?.computedAt).toBeGreaterThan(0);
  });

  it("skips peaks that are already in processed", async () => {
    storage.bag["processed"] = {
      [`${FAKE_ACTIVITY.id}:${PEAK_ID}`]: {
        processedAt: Date.now() - 1000,
        ascentId: 7,
      },
    };
    mockPipeline();

    const res = await handleProcessActivity(FAKE_ACTIVITY.id);

    expect(res).toEqual({
      ok: true,
      openedCount: 0,
      totalMatches: 1,
    });
    expect(storage.tabsCreated).toEqual([]);
  });

  it("tab URL matches the documented shape with cid and #s2p hash", async () => {
    mockPipeline();

    await handleProcessActivity(FAKE_ACTIVITY.id);

    const url = storage.tabsCreated[0]!.url;
    expect(url).toMatch(
      /^https:\/\/www\.peakbagger\.com\/climber\/ascentedit\.aspx\?pid=\d+&cid=\d+#s2p=\d+$/,
    );
    expect(url).toContain(`pid=${PEAK_ID}`);
    expect(url).toContain(`cid=99`);
    expect(url).toContain(`#s2p=${FAKE_ACTIVITY.id}`);
  });

  it("opens tabs in the background (active:false)", async () => {
    mockPipeline();

    await handleProcessActivity(FAKE_ACTIVITY.id);

    expect(storage.tabsCreated[0]!.active).toBe(false);
  });

  it("returns openedCount=0 with no tabs when there are no matches", async () => {
    // Peak nowhere near the track (>1 km away).
    const farXml = `<ts><t i="99" a="40.0" o="-120.0" n="Far Peak"/></ts>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/streams")) {
          return Promise.resolve(jsonResponse(STREAMS_BODY));
        }
        if (url.includes("PLLBB.aspx")) {
          return Promise.resolve(xmlResponse(farXml));
        }
        if (url.includes("/api/v3/activities/")) {
          return Promise.resolve(jsonResponse({ timezone: FAKE_ACTIVITY.tz }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const res = await handleProcessActivity(FAKE_ACTIVITY.id);

    expect(res).toEqual({ ok: true, openedCount: 0, totalMatches: 0 });
    expect(storage.tabsCreated).toEqual([]);
    expect(storage.bag["prefillPayloads"]).toBeUndefined();
  });

  it("preserves unrelated prefill payloads on merge", async () => {
    storage.bag["prefillPayloads"] = {
      "111:222": { pid: 222 } as never, // tag a sentinel for the test
    };
    mockPipeline();

    await handleProcessActivity(FAKE_ACTIVITY.id);

    const payloads = storage.bag["prefillPayloads"] as Record<string, unknown>;
    expect(Object.keys(payloads).sort()).toEqual(
      ["111:222", `${FAKE_ACTIVITY.id}:${PEAK_ID}`].sort(),
    );
  });
});

describe("handleAscentSaved", () => {
  it("writes processed[<stravaId>:<peakId>] with the ascentId", async () => {
    const res = await handleAscentSaved({
      stravaId: 123,
      peakId: 42,
      ascentId: 99,
    });

    expect(res).toEqual({ ok: true });
    const processed = storage.bag["processed"] as Record<
      string,
      { processedAt: number; ascentId: number | null }
    >;
    expect(processed["123:42"]?.ascentId).toBe(99);
    expect(processed["123:42"]?.processedAt).toBeGreaterThan(0);
  });

  it("accepts a null ascentId from the content script", async () => {
    const res = await handleAscentSaved({
      stravaId: 123,
      peakId: 42,
      ascentId: null,
    });

    expect(res).toEqual({ ok: true });
    const processed = storage.bag["processed"] as Record<
      string,
      { processedAt: number; ascentId: number | null }
    >;
    expect(processed["123:42"]?.ascentId).toBeNull();
  });

  it("rejects invalid stravaId or peakId", async () => {
    const res1 = await handleAscentSaved({ peakId: 1 });
    expect(res1.ok).toBe(false);

    const res2 = await handleAscentSaved({ stravaId: 1 });
    expect(res2.ok).toBe(false);
  });

  it("accepts a negative peakId (peakbagger uses these for some peaks)", async () => {
    const res = await handleAscentSaved({
      stravaId: 18158745515,
      peakId: -200643,
      ascentId: 12345,
    });
    expect(res.ok).toBe(true);
    const processed = storage.bag["processed"] as Record<string, unknown>;
    expect(processed["18158745515:-200643"]).toBeDefined();
  });

  it("preserves other processed entries on write", async () => {
    storage.bag["processed"] = {
      "999:888": { processedAt: 100, ascentId: 7 },
    };

    await handleAscentSaved({ stravaId: 123, peakId: 42, ascentId: 99 });

    const processed = storage.bag["processed"] as Record<string, unknown>;
    expect(Object.keys(processed).sort()).toEqual(["123:42", "999:888"]);
  });
});

describe("handleMarkActivityHidden", () => {
  it("works on an unmatched activity (no activityMatches entry)", async () => {
    const res = await handleMarkActivityHidden(999);
    expect(res).toEqual({ ok: true, hiddenCount: 0 });
    const hidden = storage.bag["hiddenActivities"] as Record<
      number,
      { hiddenAt: number }
    >;
    expect(hidden[999]?.hiddenAt).toBeGreaterThan(0);
  });

  it("adds null-ascentId entries for unprocessed peakIds when matches exist", async () => {
    storage.bag["activityMatches"] = {
      777: { peakIds: [1, 2, 3], computedAt: 0 },
    };
    storage.bag["processed"] = {
      "777:1": { processedAt: 100, ascentId: 99 },
    };

    const res = await handleMarkActivityHidden(777);

    expect(res).toEqual({ ok: true, hiddenCount: 2 });
    const processed = storage.bag["processed"] as Record<
      string,
      { processedAt: number; ascentId: number | null }
    >;
    expect(processed["777:1"]?.ascentId).toBe(99); // unchanged (real save)
    expect(processed["777:2"]?.ascentId).toBeNull();
    expect(processed["777:3"]?.ascentId).toBeNull();
    // hiddenActivities entry also written.
    const hidden = storage.bag["hiddenActivities"] as Record<
      number,
      { hiddenAt: number }
    >;
    expect(hidden[777]).toBeDefined();
  });
});

describe("handleMarkActivityUnhidden", () => {
  it("preserves real ascentIds; only deletes null-ascent entries", async () => {
    storage.bag["hiddenActivities"] = { 777: { hiddenAt: 50 } };
    storage.bag["activityMatches"] = {
      777: { peakIds: [1, 2, 3], computedAt: 0 },
    };
    storage.bag["processed"] = {
      "777:1": { processedAt: 100, ascentId: 99 }, // real save
      "777:2": { processedAt: 200, ascentId: null }, // null = dismissed
      "777:3": { processedAt: 300, ascentId: 42 }, // real save
      "888:1": { processedAt: 400, ascentId: 7 }, // unrelated
    };

    const res = await handleMarkActivityUnhidden(777);

    expect(res.ok).toBe(true);
    expect((res as { unhiddenCount: number }).unhiddenCount).toBe(2); // 1 hidden flag + 1 null entry
    const processed = storage.bag["processed"] as Record<string, unknown>;
    // Real ascentIds preserved; only the null entry deleted.
    expect(Object.keys(processed).sort()).toEqual(["777:1", "777:3", "888:1"]);
    const hidden = storage.bag["hiddenActivities"] as Record<number, unknown>;
    expect(hidden[777]).toBeUndefined();
  });

  it("works on an unmatched (hidden-only) activity", async () => {
    storage.bag["hiddenActivities"] = { 999: { hiddenAt: 50 } };

    const res = await handleMarkActivityUnhidden(999);

    expect(res.ok).toBe(true);
    expect((res as { unhiddenCount: number }).unhiddenCount).toBe(1);
    const hidden = storage.bag["hiddenActivities"] as Record<number, unknown>;
    expect(hidden[999]).toBeUndefined();
  });

  it("is a no-op when activity isn't hidden", async () => {
    const res = await handleMarkActivityUnhidden(999);
    expect(res).toEqual({ ok: true, unhiddenCount: 0 });
  });
});

describe("handleHideAllVisible", () => {
  it("hides every unmatched and pending activity, leaves done untouched", async () => {
    storage.bag["activities"] = [
      {
        id: 1,
        start: "x",
        startLocal: "x",
        tz: "UTC",
        name: "unmatched",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
      {
        id: 2,
        start: "x",
        startLocal: "x",
        tz: "UTC",
        name: "pending",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
      {
        id: 3,
        start: "x",
        startLocal: "x",
        tz: "UTC",
        name: "done",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
    ];
    storage.bag["activityMatches"] = {
      2: { peakIds: [10, 11], computedAt: 0 },
      3: { peakIds: [20], computedAt: 0 },
    };
    storage.bag["processed"] = {
      "2:10": { processedAt: 0, ascentId: 7 },
      // 2:11 not processed → activity 2 is "pending"
      "3:20": { processedAt: 0, ascentId: 5 },
      // activity 3 is fully done
    };

    const res = await handleHideAllVisible();

    expect(res.ok).toBe(true);
    expect((res as { hiddenCount: number }).hiddenCount).toBe(2); // 1 + 2
    const hidden = storage.bag["hiddenActivities"] as Record<
      number,
      { hiddenAt: number }
    >;
    expect(Object.keys(hidden).map(Number).sort()).toEqual([1, 2]);
    expect(hidden[3]).toBeUndefined(); // done left alone
  });

  it("skips already-hidden activities", async () => {
    storage.bag["activities"] = [
      {
        id: 1,
        start: "x",
        startLocal: "x",
        tz: "UTC",
        name: "u",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
    ];
    storage.bag["hiddenActivities"] = { 1: { hiddenAt: 100 } };

    const res = await handleHideAllVisible();

    expect((res as { hiddenCount: number }).hiddenCount).toBe(0);
  });

  it("returns 0 with empty activity list", async () => {
    const res = await handleHideAllVisible();
    expect(res).toEqual({ ok: true, hiddenCount: 0 });
  });
});

describe("handleGetTabMapping", () => {
  it("returns the mapping for a known tabId", async () => {
    storage.sessionBag["pendingTabSaves"] = {
      42: { stravaId: 123, peakId: 5 },
    };
    const res = await handleGetTabMapping(42);
    expect(res).toEqual({ ok: true, mapping: { stravaId: 123, peakId: 5 } });
  });

  it("returns mapping=null for an unknown tabId", async () => {
    storage.sessionBag["pendingTabSaves"] = {
      42: { stravaId: 123, peakId: 5 },
    };
    const res = await handleGetTabMapping(99);
    expect(res).toEqual({ ok: true, mapping: null });
  });

  it("errors when sender.tab.id is undefined", async () => {
    const res = await handleGetTabMapping(undefined);
    expect(res.ok).toBe(false);
  });
});

describe("processActivity — pendingTabSaves write", () => {
  it("records tabId → (stravaId, peakId) for each opened tab", async () => {
    storage.bag["pb"] = { climberId: 99 };
    storage.bag["activities"] = [
      {
        id: 12345678901,
        start: "2026-04-15T17:00:00Z",
        startLocal: "2026-04-15T10:00:00",
        tz: "America/Los_Angeles",
        name: "Test Hike",
        sportType: "Hike",
        distanceM: 8000,
        elevGainM: 600,
      },
    ];
    storage.bag["settings"] = {
      horizM: 75,
      vertM: 25,
      lookbackDays: 90,
      blacklist: [],
    };
    const peakXml = `<ts><t i="4242" a="37.7" o="-122.4" n="Test"/></ts>`;
    const streamsBody = {
      latlng: {
        data: [
          [37.6, -122.4],
          [37.7, -122.4],
          [37.8, -122.4],
        ],
      },
      altitude: { data: [1000, 1500, 1200] },
      time: { data: [0, 1800, 3600] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/streams")) {
          return Promise.resolve(
            new Response(JSON.stringify(streamsBody), { status: 200 }),
          );
        }
        if (url.includes("PLLBB.aspx")) {
          return Promise.resolve(
            new Response(peakXml, {
              status: 200,
              headers: { "Content-Type": "application/xml" },
            }),
          );
        }
        if (url.includes("/api/v3/activities/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ timezone: "(GMT-08:00) America/Los_Angeles" }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await handleProcessActivity(12345678901);

    const pending = storage.sessionBag["pendingTabSaves"] as Record<
      number,
      { stravaId: number; peakId: number }
    >;
    // tabsCreated.length === 1 → fake-chrome assigned tab id 1.
    expect(pending[1]).toEqual({ stravaId: 12345678901, peakId: 4242 });
  });
});

describe("runWatchdog", () => {
  it("removes pendingTabSaves entries for tabs no longer open", async () => {
    storage.sessionBag["pendingTabSaves"] = {
      1: { stravaId: 100, peakId: 10 },
      2: { stravaId: 200, peakId: 20 },
      3: { stravaId: 300, peakId: 30 },
    };
    // Override chrome.tabs.query to return only tabs 1 and 3.
    (globalThis as unknown as {
      chrome: { tabs: { query: () => Promise<unknown[]> } };
    }).chrome.tabs.query = async () => [{ id: 1 }, { id: 3 }];

    const res = await runWatchdog();

    expect(res.staleTabSavesRemoved).toBe(1);
    const pending = storage.sessionBag["pendingTabSaves"] as Record<
      number,
      unknown
    >;
    expect(Object.keys(pending).sort()).toEqual(["1", "3"]);
  });

  it("deletes prefillPayloads keys already in processed", async () => {
    storage.bag["prefillPayloads"] = {
      "1:10": { pid: 10 } as never,
      "2:20": { pid: 20 } as never,
      "3:30": { pid: 30 } as never,
    };
    storage.bag["processed"] = {
      "1:10": { processedAt: 1, ascentId: 99 },
      "3:30": { processedAt: 2, ascentId: null },
    };

    const res = await runWatchdog();

    expect(res.staleProgressRemoved).toBe(2);
    const remaining = storage.bag["prefillPayloads"] as Record<
      string,
      unknown
    >;
    expect(Object.keys(remaining)).toEqual(["2:20"]);
  });
});

describe("handleMatchBatch", () => {
  // Synthetic activity helper.
  function mkActivity(id: number, sport = "Hike") {
    return {
      id,
      start: "2026-04-15T17:00:00Z",
      startLocal: "2026-04-15T10:00:00",
      tz: "America/Los_Angeles",
      name: `act ${id}`,
      sportType: sport,
      distanceM: 1000,
      elevGainM: 100,
    };
  }

  // Mock fetch routing for the pipeline. Default: a streams response
  // for activity N that summits a peak if `withMatch.has(N)`, plus a
  // PLLBB tile response.
  function setupFetchMock(opts: {
    withMatch?: Set<number>;
    rateLimitAt?: number; // activity id at which to throw 429
    noGpsAt?: Set<number>;
  } = {}): void {
    const withMatch = opts.withMatch ?? new Set<number>();
    const noGpsAt = opts.noGpsAt ?? new Set<number>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        // /streams in the URL → look up which activity ID
        if (url.includes("/streams")) {
          const m = url.match(/activities\/(\d+)\/streams/);
          const id = m ? Number(m[1]) : NaN;
          if (id === opts.rateLimitAt) {
            return Promise.resolve(
              new Response("rate limit", {
                status: 429,
                headers: {
                  "X-Ratelimit-Limit": "100,1000",
                  "X-Ratelimit-Usage": "96,500",
                },
              }),
            );
          }
          if (noGpsAt.has(id)) {
            return Promise.resolve(
              new Response(JSON.stringify({}), { status: 200 }),
            );
          }
          // Standard streams body summiting a peak only when withMatch.
          const lat = withMatch.has(id) ? 37.7 : 38.0;
          const lng = -122.4;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                latlng: {
                  data: [
                    [lat - 0.001, lng],
                    [lat, lng],
                    [lat + 0.001, lng],
                  ],
                },
                altitude: { data: [1000, 1500, 1200] },
                time: { data: [0, 1800, 3600] },
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "X-Ratelimit-Limit": "100,1000",
                  "X-Ratelimit-Usage": "5,50",
                },
              },
            ),
          );
        }
        if (url.includes("PLLBB.aspx")) {
          // Single peak at 37.7,-122.4 — activities summit only when
          // their track passes through there (matched via withMatch).
          return Promise.resolve(
            new Response(
              `<ts><t i="4242" a="37.7" o="-122.4" n="Test"/></ts>`,
              {
                status: 200,
                headers: { "Content-Type": "application/xml" },
              },
            ),
          );
        }
        if (url.includes("/api/v3/activities/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ timezone: "(GMT-08:00) America/Los_Angeles" }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  beforeEach(() => {
    storage.bag["settings"] = {
      horizM: 75,
      vertM: 25,
      lookbackDays: 90,
      blacklist: ["Yoga"],
    };
  });

  it("stops with reason=found-pending when batch 1 yields a pending row", async () => {
    storage.bag["activities"] = [1, 2, 3, 4, 5].map((i) => mkActivity(i));
    setupFetchMock({ withMatch: new Set([1]) });

    const res = await handleMatchBatch({ startIndex: 0, size: 20 });
    if (!res.ok) throw new Error(`unexpected: ${(res as { error: string }).error}`);

    expect(res.reason).toBe("found-pending");
    expect(res.totalScanned).toBe(1);
    expect(res.totalMatches).toBe(1);
    expect(res.endIndex).toBe(1);
  });

  it("auto-continues across batches until a pending row appears", async () => {
    storage.bag["activities"] = Array.from({ length: 30 }, (_, i) => mkActivity(i + 1));
    setupFetchMock({ withMatch: new Set([25]) });

    const res = await handleMatchBatch({ startIndex: 0, size: 10 });
    if (!res.ok) throw new Error("unexpected");

    expect(res.reason).toBe("found-pending");
    expect(res.totalScanned).toBe(25);
    expect(res.endIndex).toBe(25);
  });

  it("autoContinue:false stops after one inner batch with manual-stop", async () => {
    storage.bag["activities"] = Array.from({ length: 30 }, (_, i) => mkActivity(i + 1));
    setupFetchMock({ withMatch: new Set() });

    const res = await handleMatchBatch({
      startIndex: 0,
      size: 10,
      autoContinue: false,
    });
    if (!res.ok) throw new Error("unexpected");

    expect(res.reason).toBe("manual-stop");
    expect(res.totalScanned).toBe(10);
  });

  it("returns exhausted when we run off the end of activities", async () => {
    storage.bag["activities"] = [1, 2, 3].map((i) => mkActivity(i));
    setupFetchMock({ withMatch: new Set() });

    const res = await handleMatchBatch({ startIndex: 0, size: 20 });
    if (!res.ok) throw new Error("unexpected");

    expect(res.reason).toBe("exhausted");
    expect(res.totalScanned).toBe(3);
    expect(res.endIndex).toBe(3);
  });

  it("returns rate-limited and does not cache the offending activity", async () => {
    storage.bag["activities"] = [1, 2, 3, 4].map((i) => mkActivity(i));
    setupFetchMock({ rateLimitAt: 3 });

    const res = await handleMatchBatch({ startIndex: 0, size: 10 });
    if (!res.ok) throw new Error("unexpected");

    expect(res.reason).toBe("rate-limited");
    // Activities 1, 2 should be cached (as no-match); activity 3 NOT cached.
    const cache = storage.bag["activityMatches"] as Record<number, unknown>;
    expect(cache[1]).toBeDefined();
    expect(cache[2]).toBeDefined();
    expect(cache[3]).toBeUndefined();
  });

  it("skips blacklisted activities without counting them toward the batch", async () => {
    storage.bag["activities"] = [
      mkActivity(1, "Hike"),
      mkActivity(2, "Yoga"),
      mkActivity(3, "Yoga"),
      mkActivity(4, "Hike"),
      mkActivity(5, "Hike"),
    ];
    setupFetchMock({ withMatch: new Set() });

    const res = await handleMatchBatch({
      startIndex: 0,
      size: 2,
      autoContinue: false,
    });
    if (!res.ok) throw new Error("unexpected");

    expect(res.totalScanned).toBe(2);
    const cache = storage.bag["activityMatches"] as Record<number, unknown>;
    // Yoga not cached; Hikes 1 and 4 cached.
    expect(cache[1]).toBeDefined();
    expect(cache[2]).toBeUndefined();
    expect(cache[3]).toBeUndefined();
    expect(cache[4]).toBeDefined();
  });

  it("skips already-cached activities", async () => {
    storage.bag["activities"] = [1, 2, 3, 4, 5].map((i) => mkActivity(i));
    storage.bag["activityMatches"] = {
      2: { peakIds: [], computedAt: 0 }, // pre-existing
    };
    setupFetchMock({ withMatch: new Set() });

    const res = await handleMatchBatch({
      startIndex: 0,
      size: 20,
      autoContinue: false,
    });
    if (!res.ok) throw new Error("unexpected");

    expect(res.totalScanned).toBe(4); // 1, 3, 4, 5 (2 was cached)
    const cache = storage.bag["activityMatches"] as Record<
      number,
      { peakIds: number[]; computedAt: number }
    >;
    expect(cache[2]?.computedAt).toBe(0); // untouched
  });

  it("addedPendingRow is false when all matched peaks are already in processed", async () => {
    storage.bag["activities"] = Array.from({ length: 5 }, (_, i) => mkActivity(i + 1));
    storage.bag["processed"] = {
      "1:4242": { processedAt: 0, ascentId: 99 }, // already saved
    };
    setupFetchMock({ withMatch: new Set([1, 2]) });

    const res = await handleMatchBatch({ startIndex: 0, size: 10 });
    if (!res.ok) throw new Error("unexpected");

    // Activity 1 matched but already-processed → not a pending row.
    // Activity 2 matched and is pending → stops here.
    expect(res.reason).toBe("found-pending");
    expect(res.totalScanned).toBe(2);
    expect(res.totalMatches).toBe(2);
  });

  it("writes prefillPayloads for every matched peakId", async () => {
    storage.bag["activities"] = [mkActivity(1)];
    setupFetchMock({ withMatch: new Set([1]) });

    await handleMatchBatch({ startIndex: 0, size: 1, autoContinue: false });

    const payloads = storage.bag["prefillPayloads"] as Record<string, unknown>;
    expect(payloads["1:4242"]).toBeDefined();
  });

  it("emits matchBatch:item events with cumulative totalScanned", async () => {
    storage.bag["activities"] = [1, 2, 3].map((i) => mkActivity(i));
    setupFetchMock({ withMatch: new Set() });

    await handleMatchBatch({ startIndex: 0, size: 10 });

    const items = storage.messages.filter(
      (m: unknown): m is { type: string; totalScanned: number } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "matchBatch:item",
    );
    expect(items).toHaveLength(3);
    expect(items[0]?.totalScanned).toBe(1);
    expect(items[1]?.totalScanned).toBe(2);
    expect(items[2]?.totalScanned).toBe(3);

    const done = storage.messages.find(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "matchBatch:done",
    );
    expect(done).toBeDefined();
  });
});
