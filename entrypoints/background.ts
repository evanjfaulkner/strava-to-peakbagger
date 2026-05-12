import KDBush from "kdbush";
import { matchSummits } from "../lib/matcher";
import { peaksForTrack } from "../lib/peakbagger";
import { get, getSettings } from "../lib/storage";
import { fetchActivitiesSince, fetchStreams } from "../lib/strava";

const DEV_LIST_WINDOW_MS = 7 * 24 * 3600 * 1000;

type DevResponse =
  | { ok: true; count: number }
  | { ok: false; error: string };

export default defineBackground(() => {
  console.log("strava-to-peakbagger background worker loaded");

  // Top-level listener registration is the canonical MV3 pattern —
  // Chrome will rehydrate listeners synchronously when the SW wakes.
  // Called from popup/options/content-script contexts.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "dev:list") {
      void handleDevList()
        .then((count) =>
          sendResponse({ ok: true, count } satisfies DevResponse),
        )
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies DevResponse),
        );
      return true;
    }
    if (msg?.type === "dev:peaks") {
      const activityId = Number(msg?.activityId);
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:peaks requires { activityId: number }",
        } satisfies DevResponse);
        return true;
      }
      void handleDevPeaks(activityId)
        .then((count) =>
          sendResponse({ ok: true, count } satisfies DevResponse),
        )
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies DevResponse),
        );
      return true;
    }
    if (msg?.type === "dev:match") {
      const activityId = Number(msg?.activityId);
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:match requires { activityId: number }",
        } satisfies DevResponse);
        return true;
      }
      void handleDevMatch(activityId)
        .then((count) =>
          sendResponse({ ok: true, count } satisfies DevResponse),
        )
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies DevResponse),
        );
      return true;
    }
    if (msg?.type === "dev:nearest") {
      const activityId = Number(msg?.activityId);
      const n = Number.isFinite(Number(msg?.n)) ? Number(msg.n) : 20;
      if (!Number.isFinite(activityId)) {
        sendResponse({
          ok: false,
          error: "dev:nearest requires { activityId: number, n?: number }",
        } satisfies DevResponse);
        return true;
      }
      void handleDevNearest(activityId, n)
        .then((count) =>
          sendResponse({ ok: true, count } satisfies DevResponse),
        )
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies DevResponse),
        );
      return true;
    }
    return false;
  });

  // Expose dev hooks directly on the SW global so we can invoke them
  // from the service-worker DevTools console without going through
  // chrome.runtime.sendMessage (which can't deliver to its own sender
  // context). Usage in the SW DevTools console:
  //   await s2p.devList()
  //   await s2p.devPeaks(<activity-id>)
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

    // Project + index track (same math as the matcher; this is a
    // debug-only path so we re-do it inline rather than exporting
    // the projection helpers).
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

    // For each peak, find min distance to any track point. Use a 50 km
    // search radius so kdbush returns essentially every track point —
    // the bbox is already constrained to within ~30 m of the track via
    // peaksForTrack, so this is just "find the closest match."
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
