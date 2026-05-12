import { DEFAULT_MATCH_THRESHOLDS } from "../lib/matcher";
import { peaksForTrack } from "../lib/peakbagger";
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
      };
    }
  ).s2p = {
    devList: handleDevList,
    devPeaks: handleDevPeaks,
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

async function handleDevPeaks(activityId: number): Promise<number> {
  try {
    const track = await fetchStreams(activityId);
    const peaks = await peaksForTrack(track, DEFAULT_MATCH_THRESHOLDS.horizM);
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
