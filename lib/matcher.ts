import KDBush from "kdbush";
import type { Match, Peak, Track } from "./models";

export type MatchThresholds = {
  horizM: number;
  vertM: number;
};

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
  horizM: 30,
  vertM: 25,
};

const METERS_PER_DEG_LAT = 111_000;

export function matchSummits(
  track: Track,
  peaks: Peak[],
  thresholds: MatchThresholds,
  activityStart: Date,
): Match[] {
  if (track.points.length === 0 || peaks.length === 0) return [];

  let latSum = 0;
  for (const p of track.points) latSum += p.lat;
  const lat0 = latSum / track.points.length;
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * cosLat0;

  const projectX = (lng: number): number => lng * metersPerDegLng;
  const projectY = (lat: number): number => lat * METERS_PER_DEG_LAT;

  const trackX = new Float64Array(track.points.length);
  const trackY = new Float64Array(track.points.length);
  for (let i = 0; i < track.points.length; i++) {
    const p = track.points[i]!;
    trackX[i] = projectX(p.lng);
    trackY[i] = projectY(p.lat);
  }

  const tree = new KDBush(track.points.length);
  for (let i = 0; i < track.points.length; i++) {
    tree.add(trackX[i]!, trackY[i]!);
  }
  tree.finish();

  const matches: Match[] = [];
  for (const peak of peaks) {
    const peakX = projectX(peak.lng);
    const peakY = projectY(peak.lat);

    const candidates = tree.within(peakX, peakY, thresholds.horizM);
    if (candidates.length === 0) continue;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (const idx of candidates) {
      const dx = trackX[idx]! - peakX;
      const dy = trackY[idx]! - peakY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }

    const bestPoint = track.points[bestIdx]!;

    // vertM semantics:
    //   - If peak.elevM is null, the vertical gate auto-passes and we
    //     record vertM=0. This means "gate not applicable", NOT a
    //     perfect elevation match. Downstream consumers that want to
    //     distinguish should also check peak.elevM.
    //   - Otherwise vertM is the realized |trackAlt - peakElev|.
    const altDelta =
      peak.elevM != null ? Math.abs(bestPoint.altM - peak.elevM) : 0;
    if (peak.elevM != null && altDelta > thresholds.vertM) continue;

    matches.push({
      peak,
      trackIdx: bestIdx,
      horizM: bestDist,
      vertM: altDelta,
      summitTimeUtc: new Date(
        activityStart.getTime() + bestPoint.tS * 1000,
      ).toISOString(),
    });
  }

  // ISO-8601 strings sort lexicographically the same as chronologically.
  matches.sort((a, b) => (a.summitTimeUtc < b.summitTimeUtc ? -1 : 1));
  return matches;
}
