import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  clearStravaTokens,
  get,
  getSettings,
  getStravaCreds,
  set,
  setSettings,
  setStravaCreds,
  setStravaTokens,
} from "../lib/storage";
import type { Storage } from "../lib/storage";
import { installFakeChromeStorage } from "./fakeChromeStorage";

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(() => {
  storage = installFakeChromeStorage();
});

describe("generic get/set", () => {
  it("round-trips every typed slot", async () => {
    const cases: Array<[keyof Storage, Storage[keyof Storage]]> = [
      ["strava", { clientId: "cid", clientSecret: "secret" }],
      ["pb", { climberId: 12345 }],
      [
        "settings",
        { horizM: 42, vertM: 9, lookbackDays: 7, blacklist: ["Swim"] },
      ],
      ["activities", []],
      ["peakTiles", { "37.7,-122.4": { peaks: [], fetchedAt: 1 } }],
      ["prefillPayloads", {}],
      ["processed", { "1:2": { processedAt: 1 } }],
      ["log", []],
    ];

    for (const [key, value] of cases) {
      await set(key, value as never);
      const round = await get(key);
      expect(round).toEqual(value);
    }
  });

  it("returns undefined for unset keys", async () => {
    expect(await get("strava")).toBeUndefined();
    expect(await get("settings")).toBeUndefined();
  });
});

describe("getSettings", () => {
  it("returns defaults when nothing has been stored", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a partial stored value with defaults", async () => {
    storage.bag["settings"] = { horizM: 42 };
    const merged = await getSettings();
    expect(merged.horizM).toBe(42);
    expect(merged.vertM).toBe(DEFAULT_SETTINGS.vertM);
    expect(merged.lookbackDays).toBe(DEFAULT_SETTINGS.lookbackDays);
    expect(merged.blacklist).toEqual(DEFAULT_SETTINGS.blacklist);
  });

  it("round-trips through setSettings", async () => {
    const next = {
      horizM: 11,
      vertM: 12,
      lookbackDays: 13,
      blacklist: ["Yoga"],
    };
    await setSettings(next);
    expect(await getSettings()).toEqual(next);
  });
});

describe("strava creds", () => {
  it("returns empty shape when nothing has been saved", async () => {
    expect(await getStravaCreds()).toEqual({
      clientId: "",
      clientSecret: "",
    });
  });

  it("setStravaCreds preserves existing OAuth fields", async () => {
    storage.bag["strava"] = {
      clientId: "old-id",
      clientSecret: "old-secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 1234567890,
      athleteId: 99,
    };

    await setStravaCreds({ clientId: "new-id", clientSecret: "new-secret" });

    expect(await getStravaCreds()).toEqual({
      clientId: "new-id",
      clientSecret: "new-secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 1234567890,
      athleteId: 99,
    });
  });
});

describe("strava tokens", () => {
  it("setStravaTokens preserves creds and merges in token + athlete fields", async () => {
    storage.bag["strava"] = { clientId: "cid", clientSecret: "secret" };

    await setStravaTokens({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 999,
      athleteId: 7,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    });

    expect(await get("strava")).toEqual({
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 999,
      athleteId: 7,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    });
  });

  it("clearStravaTokens removes token + athlete fields but keeps creds", async () => {
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 999,
      athleteId: 7,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    };

    await clearStravaTokens();

    expect(await get("strava")).toEqual({
      clientId: "cid",
      clientSecret: "secret",
    });
  });

  it("clearStravaTokens is a no-op when nothing is stored", async () => {
    await clearStravaTokens();
    expect(await get("strava")).toBeUndefined();
  });
});
