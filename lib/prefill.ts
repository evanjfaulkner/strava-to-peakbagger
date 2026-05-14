import type {
  ActivitySummary,
  Match,
  PrefillPayload,
  Track,
  TripChoice,
} from "./models";
import {
  durationSec,
  summitTime,
  totalDistanceM,
  totalGainM,
} from "./metrics";

const M_PER_MILE = 1609.344;
const M_PER_FOOT = 0.3048;
const STRAVA_ACTIVITY_URL = "https://www.strava.com/activities/";

export function buildPrefill(
  track: Track,
  match: Match,
  activity: ActivitySummary,
  tripChoice: TripChoice = { kind: "single" },
  siblings?: Match[],
): PrefillPayload {
  if (track.points.length === 0) {
    throw new RangeError("buildPrefill: track has no points");
  }

  // For a multi-peak activity, each ascent's "up" runs from the prior
  // summit (or trailhead) to this summit, and "down" runs to the next
  // summit (or trail end). Cumulative-from-trailhead values would
  // overcount when peakbagger sums per-ascent gain/distance across a
  // trip. Single-peak activities (siblings undefined or length 1)
  // keep trailhead → summit → trail-end semantics.
  let upStart = 0;
  let dnEnd = track.points.length - 1;
  if (siblings && siblings.length > 1) {
    const sorted = [...siblings].sort((a, b) => a.trackIdx - b.trackIdx);
    const idx = sorted.findIndex(
      (m) =>
        m.trackIdx === match.trackIdx &&
        m.peak.peakId === match.peak.peakId,
    );
    if (idx > 0) upStart = sorted[idx - 1]!.trackIdx;
    if (idx >= 0 && idx < sorted.length - 1) dnEnd = sorted[idx + 1]!.trackIdx;
  }

  const upTrack: Track = {
    points: track.points.slice(upStart, match.trackIdx + 1),
    tz: track.tz,
  };
  const dnTrack: Track = {
    points: track.points.slice(match.trackIdx, dnEnd + 1),
    tz: track.tz,
  };

  const { date, suffix } = summitTime(
    track,
    match.trackIdx,
    new Date(activity.start),
  );

  const startPoint = track.points[upStart]!;
  const endPoint = track.points[dnEnd]!;

  const upMinutes = Math.round(durationSec(upTrack) / 60);
  const dnMinutes = Math.round(durationSec(dnTrack) / 60);

  return {
    pid: match.peak.peakId,
    date,
    ascentTypeRBL: "S",
    journalText: "",
    suffixText: suffix,
    externalUrl: `${STRAVA_ACTIVITY_URL}${activity.id}`,
    startFt: Math.round(startPoint.altM / M_PER_FOOT),
    endFt: Math.round(endPoint.altM / M_PER_FOOT),
    gainFt: Math.round(totalGainM(upTrack) / M_PER_FOOT),
    upMi: roundOneDecimal(totalDistanceM(upTrack) / M_PER_MILE),
    dnMi: roundOneDecimal(totalDistanceM(dnTrack) / M_PER_MILE),
    upHr: Math.floor(upMinutes / 60),
    upMin: upMinutes % 60,
    dnHr: Math.floor(dnMinutes / 60),
    dnMin: dnMinutes % 60,
    tripChoice,
  };
}

function roundOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}
