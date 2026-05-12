import type { ActivitySummary, Track, TrackPoint } from "./models";
import { getValidAccessToken } from "./oauth";
import { get, getSettings, set } from "./storage";

export const STRAVA_API_BASE = "https://www.strava.com/api/v3";
export const PER_PAGE = 200;
export const MAX_PAGES = 10;
export const CACHE_TRIM_AT = 500;

export class StravaHTTPError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Strava API returned ${status}: ${body}`);
    this.name = "StravaHTTPError";
  }
}

export class StravaNoGPSError extends Error {
  constructor(public activityId: number) {
    super(`Activity ${activityId} has no GPS streams`);
    this.name = "StravaNoGPSError";
  }
}

type RawActivity = {
  id: number;
  name: string;
  distance: number;
  total_elevation_gain: number;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  timezone: string;
};

type RawStreams = {
  latlng?: { data: [number, number][] };
  altitude?: { data: number[] };
  time?: { data: number[] };
};

export function parseTimezone(raw: string): string {
  if (!raw) {
    console.warn(`[s2p] empty Strava timezone, falling back to UTC`);
    return "UTC";
  }
  const m = raw.match(/^\(GMT[+\-]\d{2}:\d{2}\)\s+(.+)$/);
  if (m && m[1]) return m[1].trim();
  const trimmed = raw.trim();
  if (trimmed.includes("/") || trimmed === "UTC") return trimmed;
  console.warn(
    `[s2p] could not parse Strava timezone "${raw}", falling back to UTC`,
  );
  return "UTC";
}

function mapActivity(raw: RawActivity): ActivitySummary {
  return {
    id: raw.id,
    start: raw.start_date,
    startLocal: raw.start_date_local,
    tz: parseTimezone(raw.timezone),
    name: raw.name,
    sportType: raw.sport_type,
    distanceM: raw.distance,
    elevGainM: raw.total_elevation_gain,
  };
}

async function stravaGet(path: string): Promise<unknown> {
  const token = await getValidAccessToken();
  const res = await fetch(`${STRAVA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new StravaHTTPError(res.status, body);
  }
  return res.json();
}

function sortByStartDesc<T extends { start: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.start < b.start ? 1 : -1));
}

export async function fetchActivitiesSince(
  after: Date,
): Promise<ActivitySummary[]> {
  const settings = await getSettings();
  const blacklist = new Set(settings.blacklist);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const fetched: ActivitySummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = (await stravaGet(
      `/athlete/activities?after=${afterUnix}&per_page=${PER_PAGE}&page=${page}`,
    )) as RawActivity[];

    for (const r of raw) {
      const a = mapActivity(r);
      if (!blacklist.has(a.sportType)) fetched.push(a);
    }

    if (raw.length < PER_PAGE) break;
    if (page === MAX_PAGES) {
      throw new Error(
        `Strava activity fetch exceeded MAX_PAGES (${MAX_PAGES}); widen pagination or narrow window`,
      );
    }
  }

  const sorted = sortByStartDesc(fetched);

  const existing = (await get("activities")) ?? [];
  const byId = new Map<number, ActivitySummary>();
  for (const a of existing) byId.set(a.id, a);
  for (const a of sorted) byId.set(a.id, a);
  const merged = sortByStartDesc(Array.from(byId.values())).slice(
    0,
    CACHE_TRIM_AT,
  );
  await set("activities", merged);

  return sorted;
}

export async function fetchStreams(activityId: number): Promise<Track> {
  const cached = (await get("activities")) ?? [];
  let tz = cached.find((a) => a.id === activityId)?.tz;

  if (!tz) {
    const detail = (await stravaGet(
      `/activities/${activityId}`,
    )) as RawActivity;
    tz = parseTimezone(detail.timezone);
  }

  const streams = (await stravaGet(
    `/activities/${activityId}/streams?keys=latlng,altitude,time&key_by_type=true`,
  )) as RawStreams;

  if (!streams.latlng || streams.latlng.data.length === 0) {
    throw new StravaNoGPSError(activityId);
  }

  const latlng = streams.latlng.data;
  const altitude = streams.altitude?.data ?? [];
  const time = streams.time?.data ?? [];

  if (altitude.length !== latlng.length || time.length !== latlng.length) {
    console.warn(
      `[s2p] activity ${activityId} streams misaligned: latlng=${latlng.length}, altitude=${altitude.length}, time=${time.length}`,
    );
  }

  const points: TrackPoint[] = [];
  for (let i = 0; i < latlng.length; i++) {
    const point = latlng[i];
    if (!point) continue;
    const [lat, lng] = point;
    points.push({
      lat,
      lng,
      altM: altitude[i] ?? 0,
      tS: time[i] ?? 0,
    });
  }

  return { points, tz };
}
