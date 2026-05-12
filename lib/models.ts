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

export type PrefillPayload = {
  pid: number;
  date: string;
  ascentTypeRBL: "S";
  journalText: string;
  suffixText: string;
  startFt: number;
  endFt: number;
  gainFt: number;
  upMi: number;
  dnMi: number;
  upHr: number;
  upMin: number;
  dnHr: number;
  dnMin: number;
};

export type LogEntry = {
  t: number;
  level: "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
};
