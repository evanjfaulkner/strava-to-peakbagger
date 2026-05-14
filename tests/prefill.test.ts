import { describe, expect, it } from "vitest";
import { buildPrefill } from "../lib/prefill";
import type {
  ActivitySummary,
  Match,
  Peak,
  Track,
  TrackPoint,
} from "../lib/models";

function point(
  lat: number,
  lng: number,
  altM: number,
  tS: number,
): TrackPoint {
  return { lat, lng, altM, tS };
}

const PEAK: Peak = {
  peakId: 42,
  name: "Test Peak",
  lat: 37.71,
  lng: -122.4,
  elevM: 1500,
};

const ACTIVITY: ActivitySummary = {
  id: 12345678901,
  start: "2026-04-15T17:00:00Z",
  startLocal: "2026-04-15T10:00:00",
  tz: "America/Los_Angeles",
  name: "Test ascent",
  sportType: "Hike",
  distanceM: 2220,
  elevGainM: 500,
};

// 5-point up-and-back: rises from 1000m → 1500m over the first 90 min,
// then descends back to 1000m over the next 90 min.
// Summit at index 2, tS=5400 (90 min after activity.start = 17:00 UTC),
// which lands at 18:30 UTC = 11:30 PDT on 2026-04-15.
const TRACK: Track = {
  tz: "America/Los_Angeles",
  points: [
    point(37.7, -122.4, 1000, 0),
    point(37.705, -122.4, 1250, 2700),
    point(37.71, -122.4, 1500, 5400),
    point(37.705, -122.4, 1250, 8100),
    point(37.7, -122.4, 1000, 10800),
  ],
};

const MATCH: Match = {
  peak: PEAK,
  trackIdx: 2,
  horizM: 0,
  vertM: 0,
  summitTimeUtc: "2026-04-15T18:30:00Z",
};

describe("buildPrefill — externalUrl + journalText", () => {
  it("externalUrl is the Strava activity URL for the activity id", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    expect(out.externalUrl).toBe(
      "https://www.strava.com/activities/12345678901",
    );
  });

  it("journalText is empty by default", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    expect(out.journalText).toBe("");
  });

  it("ascentTypeRBL is 'S'", () => {
    expect(buildPrefill(TRACK, MATCH, ACTIVITY).ascentTypeRBL).toBe("S");
  });

  it("pid matches the matched peak", () => {
    expect(buildPrefill(TRACK, MATCH, ACTIVITY).pid).toBe(42);
  });
});

describe("buildPrefill — date and suffixText in activity tz", () => {
  it("formats date/time at the summit instant in track.tz", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    expect(out.date).toBe("2026-04-15");
    expect(out.suffixText).toBe("11:30");
  });
});

describe("buildPrefill — elevation fields (imperial)", () => {
  it("startFt and endFt match the first and last point altitudes", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    // 1000 m / 0.3048 ≈ 3280.84 → 3281
    expect(out.startFt).toBe(3281);
    expect(out.endFt).toBe(3281);
  });

  it("gainFt uses up-track only (not total ups across the activity)", () => {
    // Up-track gain: 1000→1250 (+250) + 1250→1500 (+250) = 500 m
    // 500 m / 0.3048 ≈ 1640.42 → 1640
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    expect(out.gainFt).toBe(1640);
  });
});

describe("buildPrefill — distance fields (miles)", () => {
  it("upMi and dnMi are rounded to 1 decimal", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    // Each leg is 0.005° lat at ~111 km/deg = ~555 m. Up-track is two
    // legs = ~1110 m = ~0.69 mi → 0.7. Down-track symmetric.
    expect(out.upMi).toBeGreaterThan(0.6);
    expect(out.upMi).toBeLessThan(0.8);
    expect(out.dnMi).toBeGreaterThan(0.6);
    expect(out.dnMi).toBeLessThan(0.8);
    expect(Number.isFinite(out.upMi)).toBe(true);
    expect((out.upMi * 10) % 1).toBe(0); // single decimal place
  });
});

describe("buildPrefill — time split", () => {
  it("splits duration into hours and minutes at the summit", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    // up = 5400 s = 90 min → 1h 30m
    expect(out.upHr).toBe(1);
    expect(out.upMin).toBe(30);
    // dn = 5400 s = 90 min → 1h 30m
    expect(out.dnHr).toBe(1);
    expect(out.dnMin).toBe(30);
  });

  it("handles a 75-minute up-track as 1h 15m", () => {
    const longerTrack: Track = {
      tz: "America/Los_Angeles",
      points: [
        point(37.7, -122.4, 1000, 0),
        point(37.71, -122.4, 1500, 4500), // 75 min summit
        point(37.7, -122.4, 1000, 9000),
      ],
    };
    const m: Match = { ...MATCH, trackIdx: 1 };
    const out = buildPrefill(longerTrack, m, ACTIVITY);
    expect(out.upHr).toBe(1);
    expect(out.upMin).toBe(15);
  });
});

describe("buildPrefill — edge cases", () => {
  it("throws RangeError on an empty track", () => {
    const emptyTrack: Track = { tz: "UTC", points: [] };
    const m: Match = { ...MATCH, trackIdx: 0 };
    expect(() => buildPrefill(emptyTrack, m, ACTIVITY)).toThrow(RangeError);
  });

  it("returns zeros for derived fields on a single-point track", () => {
    const singlePointTrack: Track = {
      tz: "America/Los_Angeles",
      points: [point(37.71, -122.4, 1500, 0)],
    };
    const m: Match = {
      ...MATCH,
      trackIdx: 0,
      summitTimeUtc: "2026-04-15T17:00:00Z",
    };
    const out = buildPrefill(singlePointTrack, m, ACTIVITY);
    expect(out.startFt).toBe(out.endFt);
    expect(out.gainFt).toBe(0);
    expect(out.upMi).toBe(0);
    expect(out.dnMi).toBe(0);
    expect(out.upHr).toBe(0);
    expect(out.upMin).toBe(0);
    expect(out.dnHr).toBe(0);
    expect(out.dnMin).toBe(0);
  });

  it("handles summit at very first point (descent-only activity)", () => {
    // tS values: summit at 0, then descend over the next hour.
    const descentOnly: Track = {
      tz: "America/Los_Angeles",
      points: [
        point(37.71, -122.4, 1500, 0),
        point(37.705, -122.4, 1250, 1800),
        point(37.7, -122.4, 1000, 3600),
      ],
    };
    const m: Match = {
      ...MATCH,
      trackIdx: 0,
      summitTimeUtc: "2026-04-15T17:00:00Z",
    };
    const out = buildPrefill(descentOnly, m, ACTIVITY);
    // upTrack has 1 point → zeros
    expect(out.upMi).toBe(0);
    expect(out.gainFt).toBe(0);
    expect(out.upHr).toBe(0);
    expect(out.upMin).toBe(0);
    // dnTrack has 3 points → real values
    expect(out.dnMi).toBeGreaterThan(0);
    expect(out.dnHr).toBe(1);
    expect(out.dnMin).toBe(0);
  });

  it("handles summit at very last point (ascent-only activity)", () => {
    const ascentOnly: Track = {
      tz: "America/Los_Angeles",
      points: [
        point(37.7, -122.4, 1000, 0),
        point(37.705, -122.4, 1250, 1800),
        point(37.71, -122.4, 1500, 3600),
      ],
    };
    const m: Match = {
      ...MATCH,
      trackIdx: 2,
      summitTimeUtc: "2026-04-15T18:00:00Z",
    };
    const out = buildPrefill(ascentOnly, m, ACTIVITY);
    // upTrack has 3 points → real values
    expect(out.upMi).toBeGreaterThan(0);
    expect(out.upHr).toBe(1);
    // dnTrack has 1 point → zeros
    expect(out.dnMi).toBe(0);
    expect(out.dnHr).toBe(0);
    expect(out.dnMin).toBe(0);
  });
});

describe("buildPrefill — tripChoice", () => {
  it("defaults to { kind: 'single' } when no tripChoice arg is given", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY);
    expect(out.tripChoice).toEqual({ kind: "single" });
  });

  it("embeds a 'new' tripChoice verbatim", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY, {
      kind: "new",
      name: "Sierra Traverse",
      nights: 0,
      seq: 1,
    });
    expect(out.tripChoice).toEqual({
      kind: "new",
      name: "Sierra Traverse",
      nights: 0,
      seq: 1,
    });
  });

  it("embeds an 'attach-latest' tripChoice verbatim", () => {
    const out = buildPrefill(TRACK, MATCH, ACTIVITY, {
      kind: "attach-latest",
      seq: 2,
    });
    expect(out.tripChoice).toEqual({ kind: "attach-latest", seq: 2 });
  });
});

describe("buildPrefill — multi-peak segment metrics", () => {
  // 9-point traverse with 3 summits (A, B, C). Between each summit
  // the track dips ~200 m before climbing back. Altitudes (m):
  // 1000 → 1500(A) → 1300 → 1600(B) → 1400 → 1700(C) → 1000
  // trackIdx:  0      2        4       5        6      8       — but
  // we use 9 points (0..8) with summits at 2, 5, 8.
  const PEAK_A: Peak = { peakId: 101, name: "A", lat: 37.71, lng: -122.40, elevM: 1500 };
  const PEAK_B: Peak = { peakId: 102, name: "B", lat: 37.72, lng: -122.41, elevM: 1600 };
  const PEAK_C: Peak = { peakId: 103, name: "C", lat: 37.73, lng: -122.42, elevM: 1700 };

  const MULTI_TRACK: Track = {
    tz: "America/Los_Angeles",
    points: [
      point(37.700, -122.400, 1000, 0),       // 0 trailhead
      point(37.705, -122.400, 1250, 1800),    // 1
      point(37.710, -122.400, 1500, 3600),    // 2 summit A
      point(37.715, -122.405, 1300, 5400),    // 3 saddle
      point(37.718, -122.408, 1450, 7200),    // 4
      point(37.720, -122.410, 1600, 9000),    // 5 summit B
      point(37.725, -122.415, 1400, 10800),   // 6 saddle
      point(37.728, -122.418, 1550, 12600),   // 7
      point(37.730, -122.420, 1700, 14400),   // 8 summit C
    ],
  };
  const MATCH_A: Match = { peak: PEAK_A, trackIdx: 2, horizM: 0, vertM: 0, summitTimeUtc: "2026-04-15T18:00:00Z" };
  const MATCH_B: Match = { peak: PEAK_B, trackIdx: 5, horizM: 0, vertM: 0, summitTimeUtc: "2026-04-15T19:30:00Z" };
  const MATCH_C: Match = { peak: PEAK_C, trackIdx: 8, horizM: 0, vertM: 0, summitTimeUtc: "2026-04-15T21:00:00Z" };
  const SIBLINGS = [MATCH_A, MATCH_B, MATCH_C];

  it("ascent 1 (A): up = trailhead→A, down = A→B", () => {
    const out = buildPrefill(MULTI_TRACK, MATCH_A, ACTIVITY, { kind: "single" }, SIBLINGS);
    // up: idx 0..2 → gain 1000→1250→1500 = 500 m = ~1640 ft
    expect(out.startFt).toBe(Math.round(1000 / 0.3048));   // trailhead
    // segment end is summit B
    expect(out.endFt).toBe(Math.round(1600 / 0.3048));
    expect(out.gainFt).toBe(Math.round(500 / 0.3048));
  });

  it("ascent 2 (B): up = A→B (includes saddle dip), down = B→C", () => {
    const out = buildPrefill(MULTI_TRACK, MATCH_B, ACTIVITY, { kind: "single" }, SIBLINGS);
    // up A→B: 1500 → 1300 → 1450 → 1600 → gain = +150 +150 = 300 m
    expect(out.startFt).toBe(Math.round(1500 / 0.3048));   // prior summit A
    expect(out.endFt).toBe(Math.round(1700 / 0.3048));     // next summit C
    expect(out.gainFt).toBe(Math.round(300 / 0.3048));
  });

  it("ascent 3 (C): up = B→C, down = C→trail end", () => {
    const out = buildPrefill(MULTI_TRACK, MATCH_C, ACTIVITY, { kind: "single" }, SIBLINGS);
    // up B→C: 1600 → 1400 → 1550 → 1700 → gain = +150 +150 = 300 m
    expect(out.startFt).toBe(Math.round(1600 / 0.3048));   // prior summit B
    // C is the last summit AND last track point → endFt = C
    expect(out.endFt).toBe(Math.round(1700 / 0.3048));
    expect(out.gainFt).toBe(Math.round(300 / 0.3048));
  });

  it("per-peak gain sums to total activity gain (no double-counting)", () => {
    const a = buildPrefill(MULTI_TRACK, MATCH_A, ACTIVITY, { kind: "single" }, SIBLINGS);
    const b = buildPrefill(MULTI_TRACK, MATCH_B, ACTIVITY, { kind: "single" }, SIBLINGS);
    const c = buildPrefill(MULTI_TRACK, MATCH_C, ACTIVITY, { kind: "single" }, SIBLINGS);
    // Activity total gain: 500 (start→A) + 300 (A→B) + 300 (B→C) = 1100 m.
    // Per-ascent rounding can drift by a foot; tolerance 2 ft is plenty.
    const sumFt = a.gainFt + b.gainFt + c.gainFt;
    expect(Math.abs(sumFt - 1100 / 0.3048)).toBeLessThanOrEqual(2);
  });

  it("single-element siblings array behaves like no siblings (cumulative)", () => {
    // Lone match in siblings → length === 1 → fall back to
    // trailhead → trail-end semantics, same as omitting siblings.
    const out = buildPrefill(MULTI_TRACK, MATCH_B, ACTIVITY, { kind: "single" }, [MATCH_B]);
    // cumulative: start = 1000 (trailhead), end = 1700 (trail end)
    expect(out.startFt).toBe(Math.round(1000 / 0.3048));
    expect(out.endFt).toBe(Math.round(1700 / 0.3048));
  });

  it("omitting siblings preserves the original single-peak behavior", () => {
    const out = buildPrefill(MULTI_TRACK, MATCH_B, ACTIVITY);
    // cumulative trailhead-to-summit gain: 1000→1250→1500→1300→1450→1600
    // positives: 250 + 250 + 150 + 150 = 800 m
    expect(out.gainFt).toBe(Math.round(800 / 0.3048));
    expect(out.startFt).toBe(Math.round(1000 / 0.3048));
  });
});
