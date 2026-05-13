import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PER_PAGE,
  STRAVA_API_BASE,
  StravaHTTPError,
  StravaNoGPSError,
  fetchActivitiesSince,
  fetchStreams,
  parseTimezone,
} from "../lib/strava";
import { installFakeChromeStorage } from "./fakeChromeStorage";

const FAR_FUTURE = 9_999_999_999;

let storage: ReturnType<typeof installFakeChromeStorage>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function rawActivity(
  id: number,
  start: string,
  sportType: string = "Hike",
  name: string = `activity ${id}`,
): unknown {
  return {
    id,
    name,
    distance: 5000,
    total_elevation_gain: 600,
    sport_type: sportType,
    start_date: start,
    start_date_local: start,
    timezone: "(GMT-08:00) America/Los_Angeles",
  };
}

beforeEach(() => {
  storage = installFakeChromeStorage();
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

describe("parseTimezone", () => {
  it("extracts IANA name from Strava's GMT-prefixed format", () => {
    expect(parseTimezone("(GMT-08:00) America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    );
    expect(parseTimezone("(GMT+09:00) Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(parseTimezone("(GMT+00:00) Europe/London")).toBe("Europe/London");
  });

  it("passes through a bare IANA name", () => {
    expect(parseTimezone("America/Denver")).toBe("America/Denver");
    expect(parseTimezone("UTC")).toBe("UTC");
  });

  it("falls back to UTC on malformed input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTimezone("garbage")).toBe("UTC");
    expect(parseTimezone("")).toBe("UTC");
    expect(warn).toHaveBeenCalled();
  });
});

describe("fetchActivitiesSince — happy path", () => {
  it("maps + sorts + persists a single page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          rawActivity(2, "2026-04-02T10:00:00Z"),
          rawActivity(1, "2026-04-01T10:00:00Z"),
          rawActivity(3, "2026-04-03T10:00:00Z"),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchActivitiesSince(new Date("2026-01-01"));

    expect(out.map((a) => a.id)).toEqual([3, 2, 1]); // desc by start
    expect(out[0]!.tz).toBe("America/Los_Angeles");
    expect(out[0]!.distanceM).toBe(5000);
    expect(out[0]!.elevGainM).toBe(600);
    expect(storage.bag["activities"]).toEqual(out);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/per_page=200/);
    expect(url).toMatch(/page=1/);
    expect(url).toMatch(/after=\d+/);
  });
});

describe("fetchActivitiesSince — pagination", () => {
  it("walks multiple pages until short response", async () => {
    const fullPage = Array.from({ length: PER_PAGE }, (_, i) =>
      rawActivity(i + 1, `2026-04-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`),
    );
    const lastPage = [rawActivity(PER_PAGE + 1, "2026-05-01T10:00:00Z")];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse(lastPage));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchActivitiesSince(new Date("2026-01-01"));

    expect(out.length).toBe(PER_PAGE + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/page=1/);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/page=2/);
  });
});

describe("fetchActivitiesSince — blacklist", () => {
  it("filters out blacklisted sport types from both return and storage", async () => {
    storage.bag["settings"] = {
      horizM: 30,
      vertM: 25,
      lookbackDays: 90,
      blacklist: ["Yoga", "Workout"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          rawActivity(1, "2026-04-01T10:00:00Z", "Yoga"),
          rawActivity(2, "2026-04-02T10:00:00Z", "Hike"),
          rawActivity(3, "2026-04-03T10:00:00Z", "Workout"),
          rawActivity(4, "2026-04-04T10:00:00Z", "Run"),
        ]),
      ),
    );

    const out = await fetchActivitiesSince(new Date("2026-01-01"));

    expect(out.map((a) => a.id).sort()).toEqual([2, 4]);
    expect((storage.bag["activities"] as { id: number }[]).map((a) => a.id).sort()).toEqual([2, 4]);
  });
});

describe("fetchActivitiesSince — cache merge", () => {
  it("preserves existing entries and prefers freshly-fetched copies on id collision", async () => {
    storage.bag["activities"] = [
      {
        id: 1,
        start: "2026-03-01T10:00:00Z",
        startLocal: "2026-03-01T02:00:00",
        tz: "America/Los_Angeles",
        name: "old",
        sportType: "Hike",
        distanceM: 100,
        elevGainM: 10,
      },
      {
        id: 2,
        start: "2026-03-02T10:00:00Z",
        startLocal: "2026-03-02T02:00:00",
        tz: "America/Los_Angeles",
        name: "two",
        sportType: "Hike",
        distanceM: 200,
        elevGainM: 20,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          rawActivity(1, "2026-04-01T10:00:00Z", "Hike", "fresh"),
          rawActivity(3, "2026-04-02T10:00:00Z", "Hike", "new"),
        ]),
      ),
    );

    const out = await fetchActivitiesSince(new Date("2026-01-01"));

    expect(out.map((a) => a.id)).toEqual([3, 1]);
    const merged = storage.bag["activities"] as { id: number; name: string }[];
    expect(merged.map((a) => a.id).sort()).toEqual([1, 2, 3]);
    const id1 = merged.find((a) => a.id === 1);
    expect(id1?.name).toBe("fresh"); // freshly fetched wins on collision
  });
});

describe("fetchActivitiesSince — error handling", () => {
  it("throws StravaHTTPError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(textResponse("unauthorized", 401)),
        ),
    );

    let caught: unknown = null;
    try {
      await fetchActivitiesSince(new Date("2026-01-01"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StravaHTTPError);
    expect((caught as StravaHTTPError).status).toBe(401);
    expect((caught as StravaHTTPError).body).toContain("unauthorized");
  });

  it("throws when MAX_PAGES exceeded", async () => {
    const fullPage = Array.from({ length: PER_PAGE }, (_, i) =>
      rawActivity(
        i + 1,
        `2026-04-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(fullPage))),
    );

    await expect(fetchActivitiesSince(new Date("2026-01-01"))).rejects.toThrow(
      /MAX_PAGES/,
    );
  });
});

describe("fetchStreams — happy path", () => {
  it("zips streams using the cached activity's tz (no detail fetch)", async () => {
    storage.bag["activities"] = [
      {
        id: 42,
        start: "2026-04-01T10:00:00Z",
        startLocal: "2026-04-01T02:00:00",
        tz: "America/Denver",
        name: "test",
        sportType: "Hike",
        distanceM: 1000,
        elevGainM: 100,
      },
    ];

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        latlng: {
          data: [
            [37.7, -122.4],
            [37.71, -122.41],
            [37.72, -122.42],
          ],
        },
        altitude: { data: [100, 150, 200] },
        time: { data: [0, 30, 60] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const track = await fetchStreams(42);

    expect(track.tz).toBe("America/Denver");
    expect(track.points).toHaveLength(3);
    expect(track.points[0]).toEqual({
      lat: 37.7,
      lng: -122.4,
      altM: 100,
      tS: 0,
    });
    expect(track.points[2]).toEqual({
      lat: 37.72,
      lng: -122.42,
      altM: 200,
      tS: 60,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("/streams");
    expect(fetchMock.mock.calls[0]![0]).not.toContain(
      `${STRAVA_API_BASE}/activities/42?`,
    );
  });

  it("falls back to activity detail when tz is not cached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 99,
          name: "uncached",
          distance: 1,
          total_elevation_gain: 1,
          sport_type: "Hike",
          start_date: "2026-04-01T10:00:00Z",
          start_date_local: "2026-04-01T02:00:00",
          timezone: "(GMT+09:00) Asia/Tokyo",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          latlng: { data: [[1, 2]] },
          altitude: { data: [10] },
          time: { data: [0] },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const track = await fetchStreams(99);

    expect(track.tz).toBe("Asia/Tokyo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/activities\/99$/);
    expect(fetchMock.mock.calls[1]![0]).toContain("/streams");
  });
});

describe("fetchStreams — error handling", () => {
  it("throws StravaNoGPSError when latlng is absent", async () => {
    storage.bag["activities"] = [
      {
        id: 5,
        start: "2026-04-01T10:00:00Z",
        startLocal: "2026-04-01T02:00:00",
        tz: "UTC",
        name: "indoor",
        sportType: "VirtualRide",
        distanceM: 0,
        elevGainM: 0,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({ altitude: { data: [] }, time: { data: [] } }),
      ),
    );

    await expect(fetchStreams(5)).rejects.toThrow(StravaNoGPSError);
  });

  it("throws StravaNoGPSError when latlng is empty array", async () => {
    storage.bag["activities"] = [
      {
        id: 6,
        start: "2026-04-01T10:00:00Z",
        startLocal: "2026-04-01T02:00:00",
        tz: "UTC",
        name: "empty",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({ latlng: { data: [] }, altitude: { data: [] }, time: { data: [] } }),
      ),
    );

    await expect(fetchStreams(6)).rejects.toThrow(StravaNoGPSError);
  });

  it("pads short altitude/time arrays defensively", async () => {
    storage.bag["activities"] = [
      {
        id: 7,
        start: "2026-04-01T10:00:00Z",
        startLocal: "2026-04-01T02:00:00",
        tz: "UTC",
        name: "misaligned",
        sportType: "Hike",
        distanceM: 0,
        elevGainM: 0,
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          latlng: { data: [[1, 2], [3, 4], [5, 6]] },
          altitude: { data: [10, 20] }, // short
          time: { data: [0] }, // short
        }),
      ),
    );

    const track = await fetchStreams(7);

    expect(track.points).toHaveLength(3);
    expect(track.points[2]?.altM).toBe(0);
    expect(track.points[1]?.tS).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe("rate-limit gate", () => {
  it("blocks pre-fetch when nextRetryAt > now", async () => {
    const { StravaRateLimitError, setNextRetryAt } = await import(
      "../lib/strava"
    );
    const future = Date.now() + 60_000;
    await setNextRetryAt(future);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown = null;
    try {
      await fetchActivitiesSince(new Date("2026-01-01"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StravaRateLimitError);
    expect((caught as { nextRetryAt: number }).nextRetryAt).toBe(future);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets nextRetryAt when X-Ratelimit-Usage exceeds threshold", async () => {
    const { getNextRetryAt } = await import("../lib/strava");
    const body = JSON.stringify([
      {
        id: 1,
        name: "n",
        distance: 100,
        total_elevation_gain: 10,
        sport_type: "Hike",
        start_date: "2026-04-01T10:00:00Z",
        start_date_local: "2026-04-01T02:00:00",
        timezone: "(GMT-08:00) America/Los_Angeles",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Ratelimit-Limit": "100,1000",
              "X-Ratelimit-Usage": "96,500",
            },
          }),
        ),
      ),
    );

    await fetchActivitiesSince(new Date("2026-01-01"));

    const ts = await getNextRetryAt();
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThan(Date.now());
  });

  it("clears nextRetryAt on healthy responses", async () => {
    const { getNextRetryAt, setNextRetryAt } = await import("../lib/strava");
    await setNextRetryAt(Date.now() - 5000); // expired (in the past)

    const body = JSON.stringify([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Ratelimit-Limit": "100,1000",
              "X-Ratelimit-Usage": "5,50",
            },
          }),
        ),
      ),
    );

    await fetchActivitiesSince(new Date("2026-01-01"));

    expect(await getNextRetryAt()).toBeNull();
  });
});
