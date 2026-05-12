import type { Track } from "./models";

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = toRadians(lat2 - lat1);
  const dLambda = toRadians(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function totalDistanceM(track: Track): number {
  if (track.points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < track.points.length; i++) {
    const a = track.points[i - 1]!;
    const b = track.points[i]!;
    total += haversineM(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

export function totalGainM(track: Track): number {
  if (track.points.length < 2) return 0;
  let gain = 0;
  for (let i = 1; i < track.points.length; i++) {
    const delta = track.points[i]!.altM - track.points[i - 1]!.altM;
    if (delta > 0) gain += delta;
  }
  return gain;
}

export function durationSec(track: Track): number {
  if (track.points.length < 2) return 0;
  const first = track.points[0]!;
  const last = track.points[track.points.length - 1]!;
  return Math.max(0, last.tS - first.tS);
}

export function summitTime(
  track: Track,
  trackIdx: number,
  activityStart: Date,
): { date: string; suffix: string } {
  if (trackIdx < 0 || trackIdx >= track.points.length) {
    throw new RangeError(
      `summitTime: trackIdx ${trackIdx} out of range [0, ${track.points.length})`,
    );
  }
  const tS = track.points[trackIdx]!.tS;
  const summitInstant = new Date(activityStart.getTime() + tS * 1000);

  return {
    date: formatDateYMD(summitInstant, track.tz),
    suffix: formatTimeHM(summitInstant, track.tz),
  };
}

function formatDateYMD(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatTimeHM(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Defensive: some engines emit "24" for midnight under hour12:false.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}`;
}
