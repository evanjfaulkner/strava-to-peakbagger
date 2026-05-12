import type {
  ActivitySummary,
  LogEntry,
  Peak,
  PrefillPayload,
} from "./models";

export type Strava = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  athleteId?: number;
  athleteFirstname?: string;
  athleteLastname?: string;
};

export type StravaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  athleteId: number;
  athleteFirstname?: string;
  athleteLastname?: string;
};

export type Pb = {
  climberId?: number;
};

export type Settings = {
  horizM: number;
  vertM: number;
  lookbackDays: number;
  blacklist: string[];
};

export type Storage = {
  strava: Strava;
  pb: Pb;
  settings: Settings;
  activities: ActivitySummary[];
  peakTiles: Record<string, { peaks: Peak[]; fetchedAt: number }>;
  prefillPayloads: Record<string, PrefillPayload>;
  processed: Record<string, { processedAt: number }>;
  log: LogEntry[];
};

export const DEFAULT_SETTINGS: Settings = {
  horizM: 75,
  vertM: 25,
  lookbackDays: 90,
  blacklist: [
    "Yoga",
    "WeightTraining",
    "Workout",
    "Swim",
    "VirtualRide",
    "VirtualRun",
    "EBikeRide",
    "Crossfit",
    "Pilates",
    "Soccer",
    "Tennis",
    "Golf",
  ],
};

const EMPTY_STRAVA: Strava = { clientId: "", clientSecret: "" };

export async function get<K extends keyof Storage>(
  key: K,
): Promise<Storage[K] | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as Storage[K] | undefined;
}

export async function set<K extends keyof Storage>(
  key: K,
  value: Storage[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  const stored = await get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function setSettings(value: Settings): Promise<void> {
  await set("settings", value);
}

export async function getStravaCreds(): Promise<Strava> {
  return (await get("strava")) ?? { ...EMPTY_STRAVA };
}

export async function setStravaCreds(creds: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const current = (await get("strava")) ?? { ...EMPTY_STRAVA };
  await set("strava", { ...current, ...creds });
}

export async function setStravaTokens(tokens: StravaTokens): Promise<void> {
  const current = (await get("strava")) ?? { ...EMPTY_STRAVA };
  await set("strava", { ...current, ...tokens });
}

export async function clearStravaTokens(): Promise<void> {
  const current = await get("strava");
  if (!current) return;
  const {
    accessToken: _at,
    refreshToken: _rt,
    expiresAt: _ex,
    athleteId: _aid,
    athleteFirstname: _af,
    athleteLastname: _al,
    ...creds
  } = current;
  await set("strava", creds);
}
