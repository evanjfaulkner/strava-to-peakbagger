import { describe, expect, it } from "vitest";
import type { Peak, Track, TrackPoint } from "../lib/models";
import {
  DEFAULT_MATCH_THRESHOLDS,
  matchSummits,
} from "../lib/matcher";

function point(
  lat: number,
  lng: number,
  altM: number,
  tS: number,
): TrackPoint {
  return { lat, lng, altM, tS };
}

function track(points: TrackPoint[], tz = "UTC"): Track {
  return { points, tz };
}

function peak(
  peakId: number,
  lat: number,
  lng: number,
  elevM: number | null,
  name = `peak-${peakId}`,
): Peak {
  return { peakId, lat, lng, elevM, name };
}

// 1 degree of latitude ≈ 111_000 m, so offsetting by m / 111000 gives
// the desired horizontal distance. Used for crafting test geometry.
const M_PER_DEG = 111_000;
const offsetLat = (m: number) => m / M_PER_DEG;

const NOW = new Date("2026-04-15T17:00:00Z");

const STD: typeof DEFAULT_MATCH_THRESHOLDS = { horizM: 30, vertM: 25 };

describe("empty inputs", () => {
  it("returns [] for empty track", () => {
    expect(matchSummits(track([]), [peak(1, 0, 0, 0)], STD, NOW)).toEqual([]);
  });

  it("returns [] for empty peaks", () => {
    expect(
      matchSummits(track([point(0, 0, 0, 0)]), [], STD, NOW),
    ).toEqual([]);
  });
});

describe("matches a direct overhead pass", () => {
  it("zero-distance match with altDelta 0", () => {
    const t = track([point(37.7, -122.4, 1000, 60)]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.horizM).toBeLessThan(1);
    expect(matches[0]!.vertM).toBe(0);
    expect(matches[0]!.trackIdx).toBe(0);
    expect(matches[0]!.peak.peakId).toBe(1);
    expect(matches[0]!.summitTimeUtc).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
  });
});

describe("horizontal gate", () => {
  it("rejects a point 60 m north of the peak with horizM=30", () => {
    const t = track([
      point(37.7 + offsetLat(60), -122.4, 1000, 30),
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    expect(matchSummits(t, peaks, STD, NOW)).toEqual([]);
  });

  it("accepts a point 25 m north of the peak", () => {
    const t = track([
      point(37.7 + offsetLat(25), -122.4, 1000, 30),
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.horizM).toBeGreaterThan(24);
    expect(matches[0]!.horizM).toBeLessThan(26);
  });

  it("rejects 30.5 m and accepts 29.5 m", () => {
    const tNear = track([point(37.7 + offsetLat(29.5), -122.4, 1000, 30)]);
    const tFar = track([point(37.7 + offsetLat(30.5), -122.4, 1000, 30)]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    expect(matchSummits(tNear, peaks, STD, NOW)).toHaveLength(1);
    expect(matchSummits(tFar, peaks, STD, NOW)).toEqual([]);
  });
});

describe("vertical gate", () => {
  it("rejects 20 m horizontal + 80 m below summit with vertM=25", () => {
    const t = track([
      point(37.7 + offsetLat(20), -122.4, 920, 30), // 80 m below 1000
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    expect(matchSummits(t, peaks, STD, NOW)).toEqual([]);
  });

  it("rejects 20 m horizontal + 80 m above summit too", () => {
    const t = track([
      point(37.7 + offsetLat(20), -122.4, 1080, 30),
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    expect(matchSummits(t, peaks, STD, NOW)).toEqual([]);
  });

  it("auto-passes when peak.elevM is null, records vertM=0", () => {
    const t = track([point(37.7, -122.4, 500, 60)]);
    const peaks = [peak(1, 37.7, -122.4, null)];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.vertM).toBe(0);
  });
});

describe("traverse with two peaks", () => {
  it("matches both and sorts by summitTimeUtc ascending", () => {
    const t = track([
      point(37.7, -122.4, 1000, 600), // hits Peak A
      point(37.71, -122.4, 1100, 1800), // hits Peak B (≈1.1km north)
    ]);
    const peaks = [
      peak(2, 37.71, -122.4, 1100, "B"),
      peak(1, 37.7, -122.4, 1000, "A"),
    ];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.peak.peakId).toBe(1); // A summited first
    expect(matches[1]!.peak.peakId).toBe(2);
    expect(matches[0]!.summitTimeUtc < matches[1]!.summitTimeUtc).toBe(true);
  });
});

describe("closest-among-candidates", () => {
  it("picks the trackIdx with the minimum distance, not the first found", () => {
    const t = track([
      point(37.7 + offsetLat(22), -122.4, 1000, 60), // 22 m
      point(37.7 + offsetLat(5), -122.4, 1000, 120), // 5 m  ← closest
      point(37.7 + offsetLat(12), -122.4, 1000, 180), // 12 m
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1000)];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.trackIdx).toBe(1);
    expect(matches[0]!.horizM).toBeGreaterThan(4);
    expect(matches[0]!.horizM).toBeLessThan(6);
  });
});

describe("one match per (peak, track) pair", () => {
  it("an out-and-back over the same peak still yields one match", () => {
    const t = track([
      point(37.7 + offsetLat(11), -122.4, 1000, 60), // ~11 m before
      point(37.7, -122.4, 1010, 120), // on summit
      point(37.7 - offsetLat(11), -122.4, 1005, 180), // ~11 m after
    ]);
    const peaks = [peak(1, 37.7, -122.4, 1010)];

    const matches = matchSummits(t, peaks, STD, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.trackIdx).toBe(1); // the on-summit point wins
  });
});

describe("DEFAULT_MATCH_THRESHOLDS", () => {
  it("exports { horizM: 75, vertM: 25 }", () => {
    expect(DEFAULT_MATCH_THRESHOLDS).toEqual({ horizM: 75, vertM: 25 });
  });
});
