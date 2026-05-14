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
): PrefillPayload {
  if (track.points.length === 0) {
    throw new RangeError("buildPrefill: track has no points");
  }

  const upTrack: Track = {
    points: track.points.slice(0, match.trackIdx + 1),
    tz: track.tz,
  };
  const dnTrack: Track = {
    points: track.points.slice(match.trackIdx),
    tz: track.tz,
  };

  const { date, suffix } = summitTime(
    track,
    match.trackIdx,
    new Date(activity.start),
  );

  const firstPoint = track.points[0]!;
  const lastPoint = track.points[track.points.length - 1]!;

  const upMinutes = Math.round(durationSec(upTrack) / 60);
  const dnMinutes = Math.round(durationSec(dnTrack) / 60);

  return {
    pid: match.peak.peakId,
    date,
    ascentTypeRBL: "S",
    journalText: "",
    suffixText: suffix,
    externalUrl: `${STRAVA_ACTIVITY_URL}${activity.id}`,
    startFt: Math.round(firstPoint.altM / M_PER_FOOT),
    endFt: Math.round(lastPoint.altM / M_PER_FOOT),
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
