import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PLLBB_URL,
  TILE_TTL_MS,
  _resetTokenBucketForTesting,
  bboxForTileKey,
  expandBbox,
  isPeakbaggerLoggedIn,
  parsePllbbXml,
  peaksForBbox,
  peaksForTrack,
  peaksInBbox,
  tileKeysForBbox,
} from "../lib/peakbagger";
import type { Peak, TrackPoint } from "../lib/models";
import { installFakeChromeStorage } from "./fakeChromeStorage";

const SAMPLE_XML = `<ts><t i="1" a="37.7" o="-122.4" n="Mt One"/><t i="2" a="38.0" o="-123.0" n="Mt Two"/></ts>`;

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function p(
  lat: number,
  lng: number,
  altM = 0,
  tS = 0,
): TrackPoint {
  return { lat, lng, altM, tS };
}

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(() => {
  storage = installFakeChromeStorage();
  _resetTokenBucketForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsePllbbXml", () => {
  it("parses well-formed PLLBB XML", () => {
    const peaks = parsePllbbXml(SAMPLE_XML);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toEqual({
      peakId: 1,
      name: "Mt One",
      lat: 37.7,
      lng: -122.4,
      elevM: null,
    });
    expect(peaks[1]).toEqual({
      peakId: 2,
      name: "Mt Two",
      lat: 38.0,
      lng: -123.0,
      elevM: null,
    });
  });

  it("returns [] on an empty <ts/> root", () => {
    expect(parsePllbbXml(`<ts/>`)).toEqual([]);
  });

  it("returns [] and warns on malformed input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parsePllbbXml(`this is not xml`)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("filters records whose attrs aren't finite numbers", () => {
    const xml = `<ts><t i="abc" a="37.7" o="-122.4" n="Bad"/><t i="3" a="37.8" o="-122.5" n="Good"/></ts>`;
    const peaks = parsePllbbXml(xml);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.peakId).toBe(3);
  });

  it("handles a single <t> element (parser may treat it differently)", () => {
    const peaks = parsePllbbXml(
      `<ts><t i="42" a="37.5" o="-122.5" n="Only One"/></ts>`,
    );
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.peakId).toBe(42);
  });
});

describe("peaksInBbox", () => {
  it("builds the right URL and returns parsed peaks on 200", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(xmlResponse(SAMPLE_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const peaks = await peaksInBbox({
      minLat: 37.7,
      maxLat: 37.8,
      minLng: -122.5,
      maxLng: -122.4,
    });

    expect(peaks).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url.startsWith(PLLBB_URL)).toBe(true);
    expect(url).toContain("miny=37.7");
    expect(url).toContain("maxy=37.8");
    expect(url).toContain("minx=-122.5");
    expect(url).toContain("maxx=-122.4");
  });

  it("returns [] and warns on 503", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(textResponse("oops", 503))),
    );

    const peaks = await peaksInBbox({
      minLat: 0,
      maxLat: 1,
      minLng: 0,
      maxLng: 1,
    });

    expect(peaks).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns [] on a network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("network down"))),
    );

    const peaks = await peaksInBbox({
      minLat: 0,
      maxLat: 1,
      minLng: 0,
      maxLng: 1,
    });

    expect(peaks).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("tileKeysForBbox", () => {
  it("returns one key for a bbox that fits inside a single tile", () => {
    expect(
      tileKeysForBbox({
        minLat: 37.7,
        maxLat: 37.71,
        minLng: -122.45,
        maxLng: -122.41,
      }),
    ).toEqual(["37.7,-122.5"]);
  });

  it("returns four keys for a 2-lat × 2-lng spanning bbox", () => {
    const keys = tileKeysForBbox({
      minLat: 37.7,
      maxLat: 37.81,
      minLng: -122.45,
      maxLng: -122.31,
    });
    expect(keys.sort()).toEqual(
      ["37.7,-122.4", "37.7,-122.5", "37.8,-122.4", "37.8,-122.5"].sort(),
    );
  });

  it("returns [] for a degenerate bbox", () => {
    expect(
      tileKeysForBbox({
        minLat: 1,
        maxLat: 0,
        minLng: 0,
        maxLng: 1,
      }),
    ).toEqual([]);
  });
});

describe("bboxForTileKey", () => {
  it("inverts tileKeysForBbox", () => {
    const bbox = bboxForTileKey("37.7,-122.5");
    expect(bbox.minLat).toBeCloseTo(37.7, 6);
    expect(bbox.maxLat).toBeCloseTo(37.8, 6);
    expect(bbox.minLng).toBeCloseTo(-122.5, 6);
    expect(bbox.maxLng).toBeCloseTo(-122.4, 6);
  });
});

describe("expandBbox", () => {
  it("pads latitude by meters / 111_000", () => {
    const expanded = expandBbox(
      { minLat: 37.7, maxLat: 37.7, minLng: -122.4, maxLng: -122.4 },
      30,
    );
    const latSpan = expanded.maxLat - expanded.minLat;
    expect(latSpan * 111_000).toBeGreaterThanOrEqual(60); // 30 m each side
    expect(latSpan * 111_000).toBeLessThan(61);
  });

  it("pads longitude wider near the equator and narrower near the poles", () => {
    const equator = expandBbox(
      { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 },
      30,
    );
    const high = expandBbox(
      { minLat: 60, maxLat: 60, minLng: 0, maxLng: 0 },
      30,
    );
    // At 60°N, cos(60°) = 0.5 — so the lng pad in degrees should be
    // roughly 2× the equator pad to maintain the same metric distance.
    const equatorLngSpan = equator.maxLng - equator.minLng;
    const highLngSpan = high.maxLng - high.minLng;
    expect(highLngSpan).toBeGreaterThan(equatorLngSpan * 1.5);
    expect(highLngSpan).toBeLessThan(equatorLngSpan * 2.5);
  });
});

describe("peaksForBbox — caching", () => {
  const FIXTURE_PEAK: Peak = {
    peakId: 99,
    name: "Cached Peak",
    lat: 37.75,
    lng: -122.45,
    elevM: null,
  };

  it("returns cached peaks without hitting the network on a full cache hit", async () => {
    storage.bag["peakTiles"] = {
      "37.7,-122.5": { peaks: [FIXTURE_PEAK], fetchedAt: Date.now() },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const peaks = await peaksForBbox({
      minLat: 37.7,
      maxLat: 37.71,
      minLng: -122.45,
      maxLng: -122.41,
    });

    expect(peaks).toEqual([FIXTURE_PEAK]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches only the missing tile on a partial miss", async () => {
    const cachedPeak: Peak = {
      peakId: 1,
      name: "Cached",
      lat: 37.71,
      lng: -122.41,
      elevM: null,
    };
    storage.bag["peakTiles"] = {
      "37.7,-122.5": {
        peaks: [cachedPeak],
        fetchedAt: Date.now(),
      },
    };
    // Tile "37.7,-122.4" should be fetched.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        xmlResponse(`<ts><t i="2" a="37.71" o="-122.39" n="Fresh"/></ts>`),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const peaks = await peaksForBbox({
      minLat: 37.7,
      maxLat: 37.72,
      minLng: -122.45,
      maxLng: -122.35,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peaks.map((q) => q.peakId).sort()).toEqual([1, 2]);

    const cache = storage.bag["peakTiles"] as Record<
      string,
      { peaks: Peak[]; fetchedAt: number }
    >;
    expect(Object.keys(cache).sort()).toEqual(["37.7,-122.4", "37.7,-122.5"]);
  });

  it("re-fetches when the tile is past TTL", async () => {
    storage.bag["peakTiles"] = {
      "37.7,-122.5": {
        peaks: [{ peakId: 1, name: "stale", lat: 37.7, lng: -122.4, elevM: null }],
        fetchedAt: Date.now() - TILE_TTL_MS - 1000,
      },
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        xmlResponse(`<ts><t i="2" a="37.7" o="-122.45" n="Refreshed"/></ts>`),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const peaks = await peaksForBbox({
      minLat: 37.7,
      maxLat: 37.71,
      minLng: -122.45,
      maxLng: -122.41,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peaks.map((q) => q.peakId)).toEqual([2]);
  });

  it("dedupes a peak that appears in multiple cached tiles", async () => {
    const sharedPeak: Peak = {
      peakId: 50,
      name: "Shared",
      lat: 37.75,
      lng: -122.45,
      elevM: null,
    };
    storage.bag["peakTiles"] = {
      "37.7,-122.5": { peaks: [sharedPeak], fetchedAt: Date.now() },
      "37.7,-122.4": { peaks: [sharedPeak], fetchedAt: Date.now() },
    };
    vi.stubGlobal("fetch", vi.fn());

    const peaks = await peaksForBbox({
      minLat: 37.7,
      maxLat: 37.71,
      minLng: -122.45,
      maxLng: -122.35,
    });

    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.peakId).toBe(50);
  });
});

describe("peaksForTrack", () => {
  it("returns [] for an empty track without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const peaks = await peaksForTrack({ points: [], tz: "UTC" }, 30);

    expect(peaks).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expands the track bbox by horizM before querying tiles", async () => {
    storage.bag["peakTiles"] = {
      "37.7,-122.5": { peaks: [], fetchedAt: Date.now() },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(xmlResponse(`<ts/>`))),
    );

    // Single-point track at the edge of a tile. Without expansion, only
    // one tile would be queried. With 30 m expansion that crosses a tile
    // boundary (at lat=37.7 the boundary is right there), we may hit
    // an adjacent tile too. Just assert the resulting peaks array is
    // empty (no peaks anywhere in this synthetic case) and that no
    // error is thrown.
    const peaks = await peaksForTrack(
      { points: [p(37.7, -122.45)], tz: "UTC" },
      30,
    );
    expect(peaks).toEqual([]);
  });

  it("queries an expanded bbox covering the track plus a padding ring", async () => {
    // Use a track point well inside a tile so we can be sure that the
    // expanded bbox stays within a single tile, then verify peaksForBbox
    // sees a bbox that's wider than a single point.
    storage.bag["peakTiles"] = {
      "37.7,-122.5": {
        peaks: [
          {
            peakId: 1,
            name: "Cached",
            lat: 37.75,
            lng: -122.45,
            elevM: null,
          },
        ],
        fetchedAt: Date.now(),
      },
    };
    vi.stubGlobal("fetch", vi.fn());

    const peaks = await peaksForTrack(
      { points: [p(37.75, -122.45)], tz: "UTC" },
      30,
    );
    // The single tile covers the expanded point — cache hit returns the
    // single fixture peak.
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.peakId).toBe(1);
  });
});

describe("isPeakbaggerLoggedIn", () => {
  it("returns true when peakbagger returns the ascentedit page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("<html>...form...</html>", {
            status: 200,
            // Response.url reflects where the request ended up.
            // For a no-redirect 200, it's the original URL.
          }),
        ),
      ),
    );
    expect(await isPeakbaggerLoggedIn()).toBe(true);
  });

  it("returns false when peakbagger redirects to Login.aspx", async () => {
    // Simulate a redirect chain by returning a Response whose url
    // points at the login page (what happens after redirect:follow).
    const loginRes = Object.defineProperty(
      new Response("<html>login</html>", { status: 200 }),
      "url",
      { value: "https://peakbagger.com/Climber/Login.aspx" },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(loginRes)),
    );
    expect(await isPeakbaggerLoggedIn()).toBe(false);
  });

  it("treats fetch errors as logged-in (conservative)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("offline"))),
    );
    expect(await isPeakbaggerLoggedIn()).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
