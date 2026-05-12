import { describe, expect, it } from "vitest";
import type { Track, TrackPoint } from "../lib/models";
import {
  durationSec,
  summitTime,
  totalDistanceM,
  totalGainM,
} from "../lib/metrics";

function point(
  lat: number,
  lng: number,
  altM: number,
  tS: number,
): TrackPoint {
  return { lat, lng, altM, tS };
}

function makeTrack(points: TrackPoint[], tz = "UTC"): Track {
  return { points, tz };
}

describe("empty + single-point tracks", () => {
  it("returns 0 for distance/gain/duration on empty track", () => {
    const t = makeTrack([]);
    expect(totalDistanceM(t)).toBe(0);
    expect(totalGainM(t)).toBe(0);
    expect(durationSec(t)).toBe(0);
  });

  it("returns 0 for distance/gain/duration on single-point track", () => {
    const t = makeTrack([point(37.7, -122.4, 100, 0)]);
    expect(totalDistanceM(t)).toBe(0);
    expect(totalGainM(t)).toBe(0);
    expect(durationSec(t)).toBe(0);
  });
});

describe("totalDistanceM", () => {
  it("matches one degree of latitude near the equator within a meter or so", () => {
    const t = makeTrack([point(0, 0, 0, 0), point(1, 0, 0, 0)]);
    const d = totalDistanceM(t);
    // One degree of latitude on the IUGG sphere ≈ 111_195 m
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
    expect(Math.abs(d - 111_195)).toBeLessThan(5);
  });

  it("sums along consecutive segments", () => {
    const t = makeTrack([
      point(0, 0, 0, 0),
      point(0, 1, 0, 0),
      point(1, 1, 0, 0),
    ]);
    const segment = totalDistanceM(
      makeTrack([point(0, 0, 0, 0), point(0, 1, 0, 0)]),
    );
    const next = totalDistanceM(
      makeTrack([point(0, 1, 0, 0), point(1, 1, 0, 0)]),
    );
    expect(totalDistanceM(t)).toBeCloseTo(segment + next, 6);
  });
});

describe("totalGainM", () => {
  it("returns 0 for a flat track", () => {
    const t = makeTrack([
      point(0, 0, 100, 0),
      point(0, 0.001, 100, 60),
      point(0, 0.002, 100, 120),
      point(0, 0.003, 100, 180),
    ]);
    expect(totalGainM(t)).toBe(0);
  });

  it("sums ascending deltas exactly", () => {
    const t = makeTrack([
      point(0, 0, 100, 0),
      point(0, 0.001, 120, 60),
      point(0, 0.002, 150, 120),
      point(0, 0.003, 200, 180),
    ]);
    expect(totalGainM(t)).toBe(100); // 20 + 30 + 50
  });

  it("returns 0 for a strictly descending track", () => {
    const t = makeTrack([
      point(0, 0, 200, 0),
      point(0, 0.001, 180, 60),
      point(0, 0.002, 160, 120),
      point(0, 0.003, 140, 180),
    ]);
    expect(totalGainM(t)).toBe(0);
  });

  it("sums only positive deltas on a mixed up/down trail", () => {
    const t = makeTrack([
      point(0, 0, 100, 0),
      point(0, 0.001, 150, 60),
      point(0, 0.002, 130, 120),
      point(0, 0.003, 180, 180),
      point(0, 0.004, 160, 240),
    ]);
    // 100→150 = +50; 150→130 ignored; 130→180 = +50; 180→160 ignored
    expect(totalGainM(t)).toBe(100);
  });
});

describe("durationSec", () => {
  it("returns last.tS minus first.tS", () => {
    const t = makeTrack([
      point(0, 0, 0, 0),
      point(0, 0, 0, 30),
      point(0, 0, 0, 120),
      point(0, 0, 0, 300),
    ]);
    expect(durationSec(t)).toBe(300);
  });

  it("clamps to 0 when somehow tS is non-monotonic", () => {
    const t = makeTrack([point(0, 0, 0, 100), point(0, 0, 0, 50)]);
    expect(durationSec(t)).toBe(0);
  });
});

describe("summitTime", () => {
  it("formats date + time in America/Los_Angeles", () => {
    // 17:00 UTC + 90 min = 18:30 UTC → 11:30 PDT on 2026-04-15
    const start = new Date("2026-04-15T17:00:00Z");
    const t = makeTrack(
      [point(37.7, -122.4, 100, 0), point(37.71, -122.41, 200, 5400)],
      "America/Los_Angeles",
    );
    expect(summitTime(t, 1, start)).toEqual({
      date: "2026-04-15",
      suffix: "11:30",
    });
  });

  it("formats correctly east of UTC (Asia/Tokyo)", () => {
    // 01:00 UTC → 10:00 JST on 2026-04-15
    const start = new Date("2026-04-15T01:00:00Z");
    const t = makeTrack([point(35.68, 139.76, 5, 0)], "Asia/Tokyo");
    expect(summitTime(t, 0, start)).toEqual({
      date: "2026-04-15",
      suffix: "10:00",
    });
  });

  it("handles date crossing backwards into the previous day", () => {
    // 02:00 UTC → 19:00 PST on 2026-01-15 (PST = UTC-8)
    const start = new Date("2026-01-16T02:00:00Z");
    const t = makeTrack([point(37.7, -122.4, 0, 0)], "America/Los_Angeles");
    expect(summitTime(t, 0, start)).toEqual({
      date: "2026-01-15",
      suffix: "18:00",
    });
  });

  it("handles date crossing forwards into the next day", () => {
    // 22:00 UTC → 07:00 JST on the next day
    const start = new Date("2026-04-15T22:00:00Z");
    const t = makeTrack([point(35.68, 139.76, 5, 0)], "Asia/Tokyo");
    expect(summitTime(t, 0, start)).toEqual({
      date: "2026-04-16",
      suffix: "07:00",
    });
  });

  it("throws RangeError for an out-of-bounds index", () => {
    const t = makeTrack([point(0, 0, 0, 0)], "UTC");
    expect(() => summitTime(t, 1, new Date())).toThrow(RangeError);
    expect(() => summitTime(t, -1, new Date())).toThrow(RangeError);
  });
});
