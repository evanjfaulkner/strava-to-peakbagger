export type ActivitySummary = {
  id: number;
  start: string;
  startLocal: string;
  tz: string;
  name: string;
  sportType: string;
  distanceM: number;
  elevGainM: number;
  matchCount?: number;
};

export type TrackPoint = {
  lat: number;
  lng: number;
  altM: number;
  tS: number;
};

export type Track = {
  points: TrackPoint[];
  tz: string;
};

export type Peak = {
  peakId: number;
  name: string;
  lat: number;
  lng: number;
  elevM: number | null;
};

export type Match = {
  peak: Peak;
  trackIdx: number;
  horizM: number;
  vertM: number;
  summitTimeUtc: string;
};

/**
 * What the content script should do with peakbagger's TripDD
 * dropdown when filling the Add-Ascent form.
 *
 * - "single": this ascent isn't part of a multi-peak trip.
 *   TripDD stays at 0 (the default "Single Ascent Trip" sentinel).
 * - "new": this ascent is the first of a multi-peak trip.
 *   TripDD = -1, plus TripNameText / TripNightsText / TripSeqText.
 * - "attach-latest": this ascent attaches to the trip just created
 *   by tab 1. Content script picks the max positive TripDD option
 *   value that's > activityMatches[stravaId].priorMaxTripId.
 */
export type TripChoice =
  | { kind: "single" }
  | { kind: "new"; name: string; nights: number; seq: number }
  | { kind: "attach-latest"; seq: number };

export type PrefillPayload = {
  pid: number;
  date: string;
  ascentTypeRBL: "S";
  journalText: string;
  suffixText: string;
  // → peakbagger's "URL Link to External Trip Report" form field.
  //   Exact ASP.NET field name TBD in Step 9 (DevTools inspection).
  externalUrl: string;
  startFt: number;
  endFt: number;
  gainFt: number;
  upMi: number;
  dnMi: number;
  upHr: number;
  upMin: number;
  dnHr: number;
  dnMin: number;
  tripChoice: TripChoice;
};

export type LogEntry = {
  t: number;
  level: "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
};
