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
let handleGetTabMapping: typeof import("../entrypoints/background").handleGetTabMapping;

beforeAll(async () => {
  const mod = await import("../entrypoints/background");
  handleGetActivities = mod.handleGetActivities;
  handleRefreshActivities = mod.handleRefreshActivities;
  handleProcessActivity = mod.handleProcessActivity;
  handleAscentSaved = mod.handleAscentSaved;
  handleMarkActivityHidden = mod.handleMarkActivityHidden;
  handleMarkActivityUnhidden = mod.handleMarkActivityUnhidden;
  handleGetTabMapping = mod.handleGetTabMapping;
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

beforeEach(() => {
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
  it("adds null-ascentId entries for all peakIds not yet processed", async () => {
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
    expect(processed["777:1"]?.ascentId).toBe(99); // unchanged
    expect(processed["777:2"]?.ascentId).toBeNull();
    expect(processed["777:3"]?.ascentId).toBeNull();
  });

  it("returns ok:false when no activityMatches entry exists", async () => {
    const res = await handleMarkActivityHidden(999);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/click Open first/);
  });
});

describe("handleMarkActivityUnhidden", () => {
  it("removes all peakId entries for the activity", async () => {
    storage.bag["activityMatches"] = {
      777: { peakIds: [1, 2, 3], computedAt: 0 },
    };
    storage.bag["processed"] = {
      "777:1": { processedAt: 100, ascentId: 99 },
      "777:2": { processedAt: 200, ascentId: null },
      "777:3": { processedAt: 300, ascentId: 42 },
      "888:1": { processedAt: 400, ascentId: 7 },
    };

    const res = await handleMarkActivityUnhidden(777);

    expect(res).toEqual({ ok: true, unhiddenCount: 3 });
    const processed = storage.bag["processed"] as Record<string, unknown>;
    expect(Object.keys(processed)).toEqual(["888:1"]);
  });

  it("is a no-op when no activityMatches entry exists", async () => {
    storage.bag["processed"] = {
      "777:1": { processedAt: 100, ascentId: 99 },
    };
    const res = await handleMarkActivityUnhidden(999);
    expect(res).toEqual({ ok: true, unhiddenCount: 0 });
    const processed = storage.bag["processed"] as Record<string, unknown>;
    expect(Object.keys(processed)).toEqual(["777:1"]); // untouched
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
