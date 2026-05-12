import KDBush from "kdbush";
import { matchSummits } from "../lib/matcher";
import { peaksForTrack } from "../lib/peakbagger";
import { buildPrefill } from "../lib/prefill";
import {
  get,
  getClimberId,
  getSettings,
  set,
} from "../lib/storage";
import type { Settings } from "../lib/storage";
import { fetchActivitiesSince, fetchStreams } from "../lib/strava";
import type {
  ActivitySummary,
  Match,
  PrefillPayload,
  Track,
} from "../lib/models";

const DEV_LIST_WINDOW_MS = 7 * 24 * 3600 * 1000;
const PEAKBAGGER_ASCENT_URL =
  "https://www.peakbagger.com/climber/ascentedit.aspx";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Resp<T> = Ok<T> | Err;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ============================================================
// Real handlers (popup-facing)
// ============================================================

export type ActivityState = "unmatched" | "pending" | "done";
export type EnrichedActivity = ActivitySummary & {
  state: ActivityState;
  matchedPeakIds?: number[];
  processedPeakIds?: number[];
};

export async function handleGetActivities(
  showHidden = false,
): Promise<Resp<{ activities: EnrichedActivity[] }>> {
  try {
    const activities = (await get("activities")) ?? [];
    const activityMatches = (await get("activityMatches")) ?? {};
    const processed = (await get("processed")) ?? {};

    const enriched: EnrichedActivity[] = activities.map((a) => {
      const matches = activityMatches[a.id];
      if (!matches) {
        return { ...a, state: "unmatched" };
      }
      const processedForThis = matches.peakIds.filter(
        (pid) => processed[`${a.id}:${pid}`],
      );
      const state: ActivityState =
        processedForThis.length === matches.peakIds.length ? "done" : "pending";
      return {
        ...a,
        state,
        matchedPeakIds: matches.peakIds,
        processedPeakIds: processedForThis,
      };
    });

    const filtered = showHidden
      ? enriched
      : enriched.filter((a) => a.state !== "done");
    return { ok: true, activities: filtered };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleRefreshActivities(): Promise<
  Resp<{ count: number }>
> {
  try {
    const settings = await getSettings();
    const after = new Date(
      Date.now() - settings.lookbackDays * 86400 * 1000,
    );
    const list = await fetchActivitiesSince(after);
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleProcessActivity(
  stravaId: number,
): Promise<Resp<{ openedCount: number; totalMatches: number }>> {
  try {
    if (!Number.isFinite(stravaId) || stravaId <= 0) {
      return { ok: false, error: "Invalid stravaId" };
    }

    const cid = await getClimberId();
    if (cid === undefined) {
      return {
        ok: false,
        error:
          "Peakbagger climber ID not set — open the Options page and enter your cid first",
      };
    }

    const settings = await getSettings();
    const { activity, track, matches } = await matchActivity(
      stravaId,
      settings,
    );

    // Cache the match set FIRST so subsequent popup opens can filter
    // this activity based on processed coverage even if the rest of
    // this function fails partway through.
    const allMatches = (await get("activityMatches")) ?? {};
    allMatches[stravaId] = {
      peakIds: matches.map((m) => m.peak.peakId),
      computedAt: Date.now(),
    };
    await set("activityMatches", allMatches);

    // Filter out matches whose (stravaId, peakId) pair has already
    // been processed (saved on peakbagger OR explicitly hidden by
    // the user). Re-clicking Open on a partially-saved activity
    // should only open the remaining tabs.
    const processed = (await get("processed")) ?? {};
    const unprocessedMatches = matches.filter(
      (m) => !processed[`${stravaId}:${m.peak.peakId}`],
    );

    if (unprocessedMatches.length === 0) {
      return {
        ok: true,
        openedCount: 0,
        totalMatches: matches.length,
      };
    }

    // Build prefill payloads and merge with any existing.
    const current =
      (await get("prefillPayloads")) ?? ({} as Record<string, PrefillPayload>);
    const updated = { ...current };
    for (const m of unprocessedMatches) {
      const key = `${stravaId}:${m.peak.peakId}`;
      updated[key] = buildPrefill(track, m, activity);
    }
    await set("prefillPayloads", updated);

    // Open one tab per match, sequentially (so Chrome stages them
    // properly without overloading the tab strip).
    for (const m of unprocessedMatches) {
      const url = `${PEAKBAGGER_ASCENT_URL}?pid=${m.peak.peakId}&cid=${cid}#s2p=${stravaId}`;
      await chrome.tabs.create({ url, active: false });
    }

    return {
      ok: true,
      openedCount: unprocessedMatches.length,
      totalMatches: matches.length,
    };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleAscentSaved(msg: {
  stravaId?: unknown;
  peakId?: unknown;
  ascentId?: unknown;
}): Promise<{ ok: true } | Err> {
  try {
    const stravaId = Number(msg.stravaId);
    const peakId = Number(msg.peakId);
    if (!Number.isFinite(stravaId) || stravaId <= 0) {
      return { ok: false, error: "ascent-saved: invalid stravaId" };
    }
    // Peakbagger uses negative peakIds for some user-contributed
    // peaks (e.g. pid=-200643). Accept any finite integer.
    if (!Number.isFinite(peakId)) {
      return { ok: false, error: "ascent-saved: invalid peakId" };
    }
    const ascentId =
      typeof msg.ascentId === "number" && Number.isFinite(msg.ascentId)
        ? msg.ascentId
        : null;

    const processed = (await get("processed")) ?? {};
    processed[`${stravaId}:${peakId}`] = {
      processedAt: Date.now(),
      ascentId,
    };
    await set("processed", processed);

    console.log(
      `[s2p] ascent-saved recorded: ${stravaId}:${peakId} ascentId=${ascentId ?? "<null>"}`,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleMarkActivityHidden(
  stravaId: number,
): Promise<Resp<{ hiddenCount: number }>> {
  try {
    if (!Number.isFinite(stravaId) || stravaId <= 0) {
      return { ok: false, error: "Invalid stravaId" };
    }
    const activityMatches = (await get("activityMatches")) ?? {};
    const entry = activityMatches[stravaId];
    if (!entry) {
      return {
        ok: false,
        error: "Activity has no cached matches — click Open first",
      };
    }
    const processed = (await get("processed")) ?? {};
    let hiddenCount = 0;
    for (const peakId of entry.peakIds) {
      const key = `${stravaId}:${peakId}`;
      if (!processed[key]) {
        processed[key] = { processedAt: Date.now(), ascentId: null };
        hiddenCount++;
      }
    }
    await set("processed", processed);
    return { ok: true, hiddenCount };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleMarkActivityUnhidden(
  stravaId: number,
): Promise<Resp<{ unhiddenCount: number }>> {
  try {
    if (!Number.isFinite(stravaId) || stravaId <= 0) {
      return { ok: false, error: "Invalid stravaId" };
    }
    const activityMatches = (await get("activityMatches")) ?? {};
    const entry = activityMatches[stravaId];
    if (!entry) {
      return { ok: true, unhiddenCount: 0 };
    }
    const processed = (await get("processed")) ?? {};
    let unhiddenCount = 0;
    for (const peakId of entry.peakIds) {
      const key = `${stravaId}:${peakId}`;
      if (processed[key]) {
        delete processed[key];
        unhiddenCount++;
      }
    }
    await set("processed", processed);
    return { ok: true, unhiddenCount };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

// Helper: run the full read pipeline for one activity. Throws on
// either "activity not in cache" or any downstream error.
async function matchActivity(
  stravaId: number,
  settings: Settings,
): Promise<{ activity: ActivitySummary; track: Track; matches: Match[] }> {
  const cached = (await get("activities")) ?? [];
  const activity = cached.find((a) => a.id === stravaId);
  if (!activity) {
    throw new Error("Activity not in cache — click Refresh first");
  }
  const track = await fetchStreams(stravaId);
  const peaks = await peaksForTrack(track, settings.horizM);
  const activityStart = new Date(activity.start);
  const matches = matchSummits(
    track,
    peaks,
    { horizM: settings.horizM, vertM: settings.vertM },
    activityStart,
  );
  return { activity, track, matches };
}

// ============================================================
// Service worker entrypoint
// ============================================================

export default defineBackground(() => {
  console.log("strava-to-peakbagger background worker loaded");

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = msg?.type;

    // Popup-facing handlers
    if (type === "getActivities") {
      const showHidden = Boolean(msg?.showHidden);
      void handleGetActivities(showHidden).then(sendResponse).catch(
        (e: unknown) => sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }
    if (type === "refreshActivities") {
      void handleRefreshActivities().then(sendResponse).catch((e: unknown) =>
        sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }
    if (type === "processActivity") {
      const stravaId = Number(msg?.stravaId);
      void handleProcessActivity(stravaId).then(sendResponse).catch(
        (e: unknown) => sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }
    if (type === "markActivityHidden") {
      const stravaId = Number(msg?.stravaId);
      void handleMarkActivityHidden(stravaId).then(sendResponse).catch(
        (e: unknown) => sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }
    if (type === "markActivityUnhidden") {
      const stravaId = Number(msg?.stravaId);
      void handleMarkActivityUnhidden(stravaId).then(sendResponse).catch(
        (e: unknown) => sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }

    // Content-script-emitted signal (Step 9). Updates storage.processed
    // so the popup can filter out already-saved activities.
    if (type === "ascent-saved") {
      void handleAscentSaved(msg).then(sendResponse).catch((e: unknown) =>
        sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }

    // Dev handlers — same shape as before.
    if (type === "dev:list") {
      void handleDevList()
        .then((count) => sendResponse({ ok: true, count }))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
        );
      return true;
    }
    if (type === "dev:peaks") {
      const activityId = Number(msg?.activityId);
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:peaks requires { activityId: number }",
        });
        return true;
      }
      void handleDevPeaks(activityId)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
        );
      return true;
    }
    if (type === "dev:match") {
      const activityId = Number(msg?.activityId);
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:match requires { activityId: number }",
        });
        return true;
      }
      void handleDevMatch(activityId)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
        );
      return true;
    }
    if (type === "dev:nearest") {
      const activityId = Number(msg?.activityId);
      const n = Number.isFinite(Number(msg?.n)) ? Number(msg.n) : 20;
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:nearest requires { activityId: number, n?: number }",
        });
        return true;
      }
      void handleDevNearest(activityId, n)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
        );
      return true;
    }

    return false;
  });

  (
    globalThis as unknown as {
      s2p: {
        devList: () => Promise<number>;
        devPeaks: (activityId: number) => Promise<number>;
        devMatch: (activityId: number) => Promise<number>;
        devNearest: (activityId: number, n?: number) => Promise<number>;
      };
    }
  ).s2p = {
    devList: handleDevList,
    devPeaks: handleDevPeaks,
    devMatch: handleDevMatch,
    devNearest: handleDevNearest,
  };
});

// ============================================================
// Dev handlers (kept from earlier steps; not part of the v1 popup
// flow, but useful for SW-console debugging)
// ============================================================

async function handleDevList(): Promise<number> {
  const after = new Date(Date.now() - DEV_LIST_WINDOW_MS);
  try {
    const list = await fetchActivitiesSince(after);
    console.log(
      `[s2p] fetched ${list.length} activities since`,
      after.toISOString(),
    );
    for (const a of list.slice(0, 5)) {
      console.log(
        `  ${String(a.id).padEnd(12)}  ${a.start.slice(0, 10)}  ${a.sportType.padEnd(15)}  ${a.name}`,
      );
    }
    return list.length;
  } catch (err) {
    console.error("[s2p] dev:list failed:", err);
    throw err;
  }
}

async function handleDevMatch(activityId: number): Promise<number> {
  try {
    const settings = await getSettings();
    const cached = (await get("activities")) ?? [];
    const summary = cached.find((a) => a.id === activityId);
    if (!summary) {
      throw new Error(
        `activity ${activityId} not in storage.activities cache — run s2p.devList() first`,
      );
    }
    const track = await fetchStreams(activityId);
    const peaks = await peaksForTrack(track, settings.horizM);
    const activityStart = new Date(summary.start);
    const matches = matchSummits(
      track,
      peaks,
      { horizM: settings.horizM, vertM: settings.vertM },
      activityStart,
    );
    console.log(
      `[s2p] activity ${activityId}: ${peaks.length} candidate peaks → ${matches.length} matched summits (horizM=${settings.horizM}m, vertM=${settings.vertM}m)`,
    );
    for (const m of matches) {
      console.log(
        `  ${m.summitTimeUtc.slice(11, 16)}  ${m.horizM.toFixed(1).padStart(5)}m  #${String(m.peak.peakId).padEnd(7)} ${m.peak.name}`,
      );
    }
    return matches.length;
  } catch (err) {
    console.error(`[s2p] dev:match failed for activity ${activityId}:`, err);
    throw err;
  }
}

async function handleDevNearest(
  activityId: number,
  n = 20,
): Promise<number> {
  try {
    const settings = await getSettings();
    const track = await fetchStreams(activityId);
    if (track.points.length === 0) {
      console.warn(`[s2p] activity ${activityId} has no track points`);
      return 0;
    }
    const peaks = await peaksForTrack(track, settings.horizM);

    let latSum = 0;
    for (const p of track.points) latSum += p.lat;
    const lat0 = latSum / track.points.length;
    const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
    const mPerDegLng = 111_000 * cosLat0;
    const projectX = (lng: number): number => lng * mPerDegLng;
    const projectY = (lat: number): number => lat * 111_000;

    const trackX = new Float64Array(track.points.length);
    const trackY = new Float64Array(track.points.length);
    for (let i = 0; i < track.points.length; i++) {
      const p = track.points[i]!;
      trackX[i] = projectX(p.lng);
      trackY[i] = projectY(p.lat);
    }

    const tree = new KDBush(track.points.length);
    for (let i = 0; i < track.points.length; i++) {
      tree.add(trackX[i]!, trackY[i]!);
    }
    tree.finish();

    const SEARCH_RADIUS_M = 50_000;
    const results: { peakId: number; name: string; distM: number }[] = [];
    for (const peak of peaks) {
      const px = projectX(peak.lng);
      const py = projectY(peak.lat);
      const candidates = tree.within(px, py, SEARCH_RADIUS_M);
      if (candidates.length === 0) continue;

      let bestDist = Infinity;
      for (const idx of candidates) {
        const dx = trackX[idx]! - px;
        const dy = trackY[idx]! - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) bestDist = d;
      }
      results.push({ peakId: peak.peakId, name: peak.name, distM: bestDist });
    }

    results.sort((a, b) => a.distM - b.distM);
    const topN = results.slice(0, n);

    console.log(
      `[s2p] activity ${activityId}: ${peaks.length} candidates; top ${topN.length} nearest:`,
    );
    for (const r of topN) {
      console.log(
        `  ${r.distM.toFixed(1).padStart(7)}m  #${String(r.peakId).padEnd(7)} ${r.name}  https://peakbagger.com/peak.aspx?pid=${r.peakId}`,
      );
    }
    return topN.length;
  } catch (err) {
    console.error(`[s2p] dev:nearest failed for activity ${activityId}:`, err);
    throw err;
  }
}

async function handleDevPeaks(activityId: number): Promise<number> {
  try {
    const settings = await getSettings();
    const track = await fetchStreams(activityId);
    const peaks = await peaksForTrack(track, settings.horizM);
    console.log(
      `[s2p] activity ${activityId}: track has ${track.points.length} points, found ${peaks.length} candidate peaks`,
    );
    for (const peak of peaks.slice(0, 5)) {
      console.log(
        `  #${String(peak.peakId).padEnd(7)} ${peak.lat.toFixed(4).padEnd(8)} ${peak.lng.toFixed(4).padEnd(10)} ${peak.name}`,
      );
    }
    return peaks.length;
  } catch (err) {
    console.error(`[s2p] dev:peaks failed for activity ${activityId}:`, err);
    throw err;
  }
}
