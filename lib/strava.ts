import type { ActivitySummary, Track, TrackPoint } from "./models";
import { log } from "./log";
import { getValidAccessToken } from "./oauth";
import { get, getSettings, set } from "./storage";

export const STRAVA_API_BASE = "https://www.strava.com/api/v3";
export const PER_PAGE = 200;
export const MAX_PAGES = 10;
export const CACHE_TRIM_AT = 500;
// Trip the rate-limit gate when we've used ≥95% of either bucket
// (15-min or daily) on a successful response. 95% leaves room for
// a couple more in-flight calls without crossing the actual limit.
export const RATE_LIMIT_TRIP_PCT = 0.95;
export const RATE_LIMIT_BUCKET_MS = 15 * 60 * 1000;
const SESSION_KEY = "stravaNextRetryAt";

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

export class StravaRateLimitError extends Error {
  constructor(public nextRetryAt: number) {
    super(
      `Strava rate limit reached; retry after ${new Date(nextRetryAt).toISOString()}`,
    );
    this.name = "StravaRateLimitError";
  }
}

export async function getNextRetryAt(): Promise<number | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const v = (stored as Record<string, unknown>)[SESSION_KEY];
  return typeof v === "number" ? v : null;
}

export async function setNextRetryAt(ts: number | null): Promise<void> {
  if (ts === null) {
    await chrome.storage.session.remove(SESSION_KEY);
  } else {
    await chrome.storage.session.set({ [SESSION_KEY]: ts });
  }
}

function parseRatePair(header: string | null): [number, number] | null {
  if (!header) return null;
  const parts = header.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  return [parts[0]!, parts[1]!];
}

async function recordRateLimit(res: Response): Promise<void> {
  const limit = parseRatePair(res.headers.get("X-Ratelimit-Limit"));
  const usage = parseRatePair(res.headers.get("X-Ratelimit-Usage"));
  if (!limit || !usage) return;

  const [limit15, limitDay] = limit;
  const [used15, usedDay] = usage;
  const usagePct = Math.max(
    limit15 > 0 ? used15 / limit15 : 0,
    limitDay > 0 ? usedDay / limitDay : 0,
  );

  if (usagePct >= RATE_LIMIT_TRIP_PCT) {
    const now = Date.now();
    const nextBoundary =
      Math.ceil(now / RATE_LIMIT_BUCKET_MS) * RATE_LIMIT_BUCKET_MS;
    await setNextRetryAt(nextBoundary);
    void log("warn", "Strava rate limit reached", {
      nextRetryAt: nextBoundary,
      usage15: `${used15}/${limit15}`,
      usageDay: `${usedDay}/${limitDay}`,
    });
  } else {
    // Healthy response — clear any prior cooldown so the next call
    // doesn't get blocked by stale state.
    const current = await getNextRetryAt();
    if (current !== null) await setNextRetryAt(null);
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
  const nextRetryAt = await getNextRetryAt();
  if (nextRetryAt !== null && Date.now() < nextRetryAt) {
    throw new StravaRateLimitError(nextRetryAt);
  }

  const token = await getValidAccessToken();
  const res = await fetch(`${STRAVA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new StravaHTTPError(res.status, body);
  }
  await recordRateLimit(res);
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
