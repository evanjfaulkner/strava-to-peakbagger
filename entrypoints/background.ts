import { fetchActivitiesSince } from "../lib/strava";

const DEV_LIST_WINDOW_MS = 7 * 24 * 3600 * 1000;

type DevListResponse =
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
          sendResponse({ ok: true, count } satisfies DevListResponse),
        )
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies DevListResponse),
        );
      // Keep the message channel open for the async sendResponse.
      return true;
    }
    return false;
  });

  // Expose dev hooks directly on the SW global so we can invoke them
  // from the service-worker DevTools console without going through
  // chrome.runtime.sendMessage (which can't deliver to its own sender
  // context). Usage in the SW DevTools console:
  //   await s2p.devList()
  (globalThis as unknown as { s2p: { devList: () => Promise<number> } }).s2p =
    {
      devList: handleDevList,
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
        `  ${a.start.slice(0, 10)}  ${a.sportType.padEnd(15)}  ${a.name}`,
      );
    }
    return list.length;
  } catch (err) {
    console.error("[s2p] dev:list failed:", err);
    throw err;
  }
}
