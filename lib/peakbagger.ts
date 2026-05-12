import { XMLParser } from "fast-xml-parser";
import type { Peak, Track } from "./models";
import { get, set } from "./storage";

export const PLLBB_URL = "https://peakbagger.com/Async/PLLBB.aspx";
export const TILE_SIZE_DEG = 0.1;
export const TILE_TTL_MS = 7 * 24 * 3600 * 1000;
export const USER_AGENT =
  "strava-to-peakbagger/0.1 (+https://github.com/evanjfaulkner/strava-to-peakbagger)";
const METERS_PER_DEG_LAT = 111_000;

export type Bbox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

type RawPeakRecord = {
  i?: string;
  a?: string;
  o?: string;
  n?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  isArray: (name) => name === "t",
});

export function parsePllbbXml(xml: string): Peak[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    console.warn("[s2p] failed to parse PLLBB XML:", e);
    return [];
  }

  const ts = (parsed as { ts?: { t?: RawPeakRecord[] } } | undefined)?.ts;
  if (!ts) {
    console.warn("[s2p] PLLBB response missing <ts> root");
    return [];
  }
  const items = ts.t ?? [];

  const peaks: Peak[] = [];
  for (const rec of items) {
    const peakId = Number(rec.i);
    const lat = Number(rec.a);
    const lng = Number(rec.o);
    if (!Number.isFinite(peakId) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    peaks.push({
      peakId,
      name: rec.n ?? "",
      lat,
      lng,
      elevM: null,
    });
  }
  return peaks;
}

export async function peaksInBbox(bbox: Bbox): Promise<Peak[]> {
  const params = new URLSearchParams({
    miny: String(bbox.minLat),
    maxy: String(bbox.maxLat),
    minx: String(bbox.minLng),
    maxx: String(bbox.maxLng),
  });
  const url = `${PLLBB_URL}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/xml",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (e) {
    console.warn("[s2p] PLLBB fetch failed:", e);
    return [];
  }

  if (!res.ok) {
    console.warn(`[s2p] PLLBB returned ${res.status} for bbox`, bbox);
    return [];
  }

  const body = await res.text().catch(() => "");
  return parsePllbbXml(body);
}

export function tileKeysForBbox(bbox: Bbox): string[] {
  if (bbox.maxLat < bbox.minLat || bbox.maxLng < bbox.minLng) return [];

  const startLatI = Math.floor(bbox.minLat / TILE_SIZE_DEG);
  const endLatI = Math.floor(bbox.maxLat / TILE_SIZE_DEG);
  const startLngI = Math.floor(bbox.minLng / TILE_SIZE_DEG);
  const endLngI = Math.floor(bbox.maxLng / TILE_SIZE_DEG);

  const keys: string[] = [];
  for (let latI = startLatI; latI <= endLatI; latI++) {
    for (let lngI = startLngI; lngI <= endLngI; lngI++) {
      const lat = (latI * TILE_SIZE_DEG).toFixed(1);
      const lng = (lngI * TILE_SIZE_DEG).toFixed(1);
      keys.push(`${lat},${lng}`);
    }
  }
  return keys;
}

export function bboxForTileKey(key: string): Bbox {
  const [latStr, lngStr] = key.split(",");
  const lat = Number(latStr);
  const lng = Number(lngStr);
  return {
    minLat: lat,
    maxLat: lat + TILE_SIZE_DEG,
    minLng: lng,
    maxLng: lng + TILE_SIZE_DEG,
  };
}

export function expandBbox(bbox: Bbox, meters: number): Bbox {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const cosMid = Math.cos((midLat * Math.PI) / 180);
  const latPad = meters / METERS_PER_DEG_LAT;
  // Guard against cos(midLat) ≈ 0 near the poles; clamp to a sane minimum.
  const lngPad = meters / (METERS_PER_DEG_LAT * Math.max(cosMid, 0.01));
  return {
    minLat: bbox.minLat - latPad,
    maxLat: bbox.maxLat + latPad,
    minLng: bbox.minLng - lngPad,
    maxLng: bbox.maxLng + lngPad,
  };
}

export async function peaksForBbox(bbox: Bbox): Promise<Peak[]> {
  const keys = tileKeysForBbox(bbox);
  if (keys.length === 0) return [];

  const cache = (await get("peakTiles")) ?? {};
  const now = Date.now();

  const hits: Peak[][] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const entry = cache[key];
    if (entry && now - entry.fetchedAt < TILE_TTL_MS) {
      hits.push(entry.peaks);
    } else {
      missing.push(key);
    }
  }

  const fetched = await Promise.all(
    missing.map(async (key) => ({
      key,
      peaks: await peaksInBbox(bboxForTileKey(key)),
    })),
  );

  if (fetched.length > 0) {
    const updated = { ...cache };
    for (const { key, peaks } of fetched) {
      updated[key] = { peaks, fetchedAt: now };
    }
    await set("peakTiles", updated);
  }

  const byId = new Map<number, Peak>();
  for (const peaks of hits) {
    for (const p of peaks) byId.set(p.peakId, p);
  }
  for (const { peaks } of fetched) {
    for (const p of peaks) byId.set(p.peakId, p);
  }
  return Array.from(byId.values());
}

export async function peaksForTrack(
  track: Track,
  horizM: number,
): Promise<Peak[]> {
  if (track.points.length === 0) return [];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of track.points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  const bbox = expandBbox({ minLat, maxLat, minLng, maxLng }, horizM);
  return peaksForBbox(bbox);
}
