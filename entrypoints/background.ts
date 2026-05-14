import KDBush from "kdbush";
import { log } from "../lib/log";
import { matchSummits } from "../lib/matcher";
import { isPeakbaggerLoggedIn, peaksForTrack } from "../lib/peakbagger";
import { buildPrefill } from "../lib/prefill";
import {
  get,
  getClimberId,
  getSettings,
  set,
  setMatchSession,
} from "../lib/storage";
import type { Settings } from "../lib/storage";
import {
  StravaRateLimitError,
  StravaNoGPSError,
  fetchActivitiesSince,
  fetchStreams,
} from "../lib/strava";
import type {
  ActivitySummary,
  Match,
  PrefillPayload,
  Track,
  TripChoice,
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
// Per-tab pending-save mapping (chrome.storage.session)
// ============================================================
//
// When the popup opens an Add-Ascent tab, we record the
// (stravaId, peakId) the tab was opened for. After the user clicks
// Save, peakbagger's POST→redirect drops the URL hash, so the
// content script can't recover the stravaId from the URL anymore.
// It queries the SW via getTabMapping, which reads this map.

type TabMapping = { stravaId: number; peakId: number };

async function getPendingTabSaves(): Promise<Record<number, TabMapping>> {
  const stored = await chrome.storage.session.get("pendingTabSaves");
  return (
    (stored.pendingTabSaves as Record<number, TabMapping> | undefined) ?? {}
  );
}

async function setPendingTabSaves(
  value: Record<number, TabMapping>,
): Promise<void> {
  await chrome.storage.session.set({ pendingTabSaves: value });
}

export async function handleGetTabMapping(
  tabId: number | undefined,
): Promise<{ ok: true; mapping: TabMapping | null } | Err> {
  try {
    if (tabId === undefined) {
      return { ok: false, error: "No tab id on sender" };
    }
    const pending = await getPendingTabSaves();
    return { ok: true, mapping: pending[tabId] ?? null };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

// ============================================================
// Watchdog — periodic cleanup of stale state
// ============================================================
//
// Two sweeps:
// 1. pendingTabSaves (session-storage): tabs.onRemoved already drops
//    entries when the user closes a tab. The watchdog catches
//    anything orphaned by SW restarts or other edge cases.
// 2. prefillPayloads (local): payload entries whose (stravaId,
//    peakId) is already in processed are dead weight. Removing them
//    keeps quota usage sane long-term.

export async function runWatchdog(): Promise<{
  staleTabSavesRemoved: number;
  staleProgressRemoved: number;
}> {
  let staleTabSavesRemoved = 0;
  let staleProgressRemoved = 0;
  try {
    // Sweep pendingTabSaves vs currently-open tabs.
    const pending = await getPendingTabSaves();
    const openTabs = await chrome.tabs.query({});
    const openIds = new Set(
      openTabs.map((t) => t.id).filter((id): id is number => id !== undefined),
    );
    const updated: Record<number, TabMapping> = {};
    for (const [tabIdStr, mapping] of Object.entries(pending)) {
      const tabId = Number(tabIdStr);
      if (openIds.has(tabId)) {
        updated[tabId] = mapping;
      } else {
        staleTabSavesRemoved++;
      }
    }
    if (staleTabSavesRemoved > 0) await setPendingTabSaves(updated);

    // Sweep prefillPayloads vs processed.
    const payloads = (await get("prefillPayloads")) ?? {};
    const processed = (await get("processed")) ?? {};
    const trimmed: Record<string, PrefillPayload> = {};
    for (const [key, payload] of Object.entries(payloads)) {
      if (processed[key]) {
        staleProgressRemoved++;
      } else {
        trimmed[key] = payload;
      }
    }
    if (staleProgressRemoved > 0) await set("prefillPayloads", trimmed);

    if (staleTabSavesRemoved > 0 || staleProgressRemoved > 0) {
      void log("info", "Watchdog swept stale state", {
        staleTabSavesRemoved,
        staleProgressRemoved,
      });
    }
  } catch (e) {
    void log("error", "Watchdog failed", { error: errMessage(e) });
  }
  return { staleTabSavesRemoved, staleProgressRemoved };
}

// ============================================================
// Real handlers (popup-facing)
// ============================================================

export type ActivityState =
  | "unmatched"
  | "no-match"
  | "pending"
  | "done"
  | "hidden";
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
    const hiddenActivities = (await get("hiddenActivities")) ?? {};

    const enriched: EnrichedActivity[] = activities.map((a) => {
      const matches = activityMatches[a.id];
      const isHidden = !!hiddenActivities[a.id];

      if (!matches) {
        // No match cache: either user has never clicked Open, or
        // they clicked Hide on an unmatched activity.
        const state: ActivityState = isHidden ? "hidden" : "unmatched";
        return { ...a, state };
      }

      // Empty-peakIds means "tried, found nothing" — distinct from
      // "done" (saved on peakbagger) but filtered the same way by
      // default. Hidden takes precedence so the user-dismissed
      // case is still labeled as such under Show hidden.
      if (matches.peakIds.length === 0) {
        const state: ActivityState = isHidden ? "hidden" : "no-match";
        return { ...a, state, matchedPeakIds: [], processedPeakIds: [] };
      }

      const processedForThis = matches.peakIds.filter(
        (pid) => processed[`${a.id}:${pid}`],
      );
      let state: ActivityState;
      if (processedForThis.length === matches.peakIds.length) {
        state = "done";
      } else if (isHidden) {
        // Hidden takes precedence over a partial-save state — the
        // user explicitly said "don't show me this."
        state = "hidden";
      } else {
        state = "pending";
      }
      return {
        ...a,
        state,
        matchedPeakIds: matches.peakIds,
        processedPeakIds: processedForThis,
      };
    });

    // Default view shows ONLY pending activities — the actionable
    // ones (matched, at least one peak un-saved). Every other
    // state filters out:
    //   - unmatched: not yet processed by the matcher; no match
    //     data to act on.
    //   - no-match: tried, no peaks found.
    //   - done: all peaks saved.
    //   - hidden: user-dismissed.
    // Show hidden reveals everything for recovery.
    const filtered = showHidden
      ? enriched
      : enriched.filter((a) => a.state === "pending");
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

// ============================================================
// Batch matching (v0.2)
// ============================================================

export type MatchBatchRequest = {
  startIndex: number;
  size: number;
  autoContinue?: boolean; // default true
};

export type MatchBatchReason =
  | "found-pending"
  | "rate-limited"
  | "exhausted"
  | "manual-stop";

export type MatchBatchResult = {
  sessionId: string;
  totalScanned: number;
  totalMatches: number;
  endIndex: number;
  reason: MatchBatchReason;
};

type PipelineOutcome =
  | { kind: "rate-limited" }
  | { kind: "no-gps" }
  | { kind: "error" }
  | { kind: "matched"; matchCount: number; addedPendingRow: boolean };

async function emitMatchEvent(message: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No popup listening → expected when running from SW console.
  }
}

async function runPipelineForActivity(
  activity: ActivitySummary,
  settings: Settings,
  processed: Record<string, { processedAt: number; ascentId: number | null }>,
): Promise<PipelineOutcome> {
  let track;
  try {
    track = await fetchStreams(activity.id);
  } catch (e) {
    if (e instanceof StravaRateLimitError) return { kind: "rate-limited" };
    if (e instanceof StravaNoGPSError) {
      const cache = (await get("activityMatches")) ?? {};
      cache[activity.id] = { peakIds: [], computedAt: Date.now() };
      await set("activityMatches", cache);
      return { kind: "no-gps" };
    }
    void log("warn", "matchBatch: pipeline error", {
      stravaId: activity.id,
      error: errMessage(e),
    });
    const cache = (await get("activityMatches")) ?? {};
    cache[activity.id] = { peakIds: [], computedAt: Date.now() };
    await set("activityMatches", cache);
    return { kind: "error" };
  }

  const peaks = await peaksForTrack(track, settings.horizM);
  const matches = matchSummits(
    track,
    peaks,
    { horizM: settings.horizM, vertM: settings.vertM },
    new Date(activity.start),
  );

  const cache = (await get("activityMatches")) ?? {};
  cache[activity.id] = {
    peakIds: matches.map((m) => m.peak.peakId),
    computedAt: Date.now(),
  };
  await set("activityMatches", cache);

  if (matches.length > 0) {
    const payloads = (await get("prefillPayloads")) ?? {};
    for (const m of matches) {
      payloads[`${activity.id}:${m.peak.peakId}`] = buildPrefill(
        track,
        m,
        activity,
        { kind: "single" },
        matches,
      );
    }
    await set("prefillPayloads", payloads);
  }

  const addedPendingRow = matches.some(
    (m) => !processed[`${activity.id}:${m.peak.peakId}`],
  );
  return { kind: "matched", matchCount: matches.length, addedPendingRow };
}

export async function handleMatchBatch(
  req: MatchBatchRequest,
): Promise<Resp<MatchBatchResult>> {
  try {
    const size = Math.max(1, Math.floor(req.size));
    const autoContinue = req.autoContinue !== false;
    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const activities = (await get("activities")) ?? [];
    const settings = await getSettings();
    const blacklist = new Set(settings.blacklist);

    let i = Math.max(0, Math.floor(req.startIndex));
    let totalScanned = 0;
    let totalMatches = 0;
    let reason: MatchBatchReason = "manual-stop";

    outer: while (true) {
      let attempted = 0;

      while (attempted < size && i < activities.length) {
        const activity = activities[i]!;
        if (blacklist.has(activity.sportType)) {
          i++;
          continue;
        }
        const existingMatches = (await get("activityMatches")) ?? {};
        if (existingMatches[activity.id]) {
          i++;
          continue;
        }

        const processed = (await get("processed")) ?? {};
        const outcome = await runPipelineForActivity(
          activity,
          settings,
          processed,
        );

        if (outcome.kind === "rate-limited") {
          reason = "rate-limited";
          // Cursor stays at this index — we'll retry this activity
          // after the cooldown.
          break outer;
        }

        const peakCount =
          outcome.kind === "matched" ? outcome.matchCount : 0;
        const addedPendingRow =
          outcome.kind === "matched" ? outcome.addedPendingRow : false;

        i++;
        attempted++;
        totalScanned++;
        if (peakCount > 0) totalMatches++;

        void emitMatchEvent({
          type: "matchBatch:item",
          sessionId,
          stravaId: activity.id,
          peakCount,
          addedPendingRow,
          totalScanned,
        });

        // Stop on a pending row (a match with at least one peak
        // that isn't already saved). Already-done matches keep the
        // loop running — the user is looking for actionable items.
        if (addedPendingRow) {
          reason = "found-pending";
          break outer;
        }
      }

      // End of one inner batch.
      const existing = (await get("matchSession")) ?? undefined;
      await setMatchSession({
        lastAutoRefreshDay: existing?.lastAutoRefreshDay ?? "",
        lastBatchEndIndex: i,
      });

      if (i >= activities.length) {
        reason = "exhausted";
        break outer;
      }
      if (!autoContinue) {
        reason = "manual-stop";
        break outer;
      }
      // Otherwise: continue auto-batching.
    }

    // Final cursor write (in case we broke before the inner-end write).
    const existing = (await get("matchSession")) ?? undefined;
    await setMatchSession({
      lastAutoRefreshDay: existing?.lastAutoRefreshDay ?? "",
      lastBatchEndIndex: i,
    });

    void emitMatchEvent({
      type: "matchBatch:done",
      sessionId,
      totalScanned,
      totalMatches,
      endIndex: i,
      reason,
    });

    return {
      ok: true,
      sessionId,
      totalScanned,
      totalMatches,
      endIndex: i,
      reason,
    };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

// Shared helper used by handleLogAscents (Step 4) and
// handleAscentSaved (Step 5) to open one peakbagger tab and
// record the (tabId → {stravaId, peakId}) mapping for the
// post-save lookup.
export async function openOneTab(
  stravaId: number,
  peakId: number,
  cid: number,
): Promise<void> {
  const url = `${PEAKBAGGER_ASCENT_URL}?pid=${peakId}&cid=${cid}#s2p=${stravaId}`;
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id !== undefined) {
    const pending = await getPendingTabSaves();
    pending[tab.id] = { stravaId, peakId };
    await setPendingTabSaves(pending);
  }
}

export async function handleLogAscents(stravaId: number): Promise<
  Resp<{ openedCount: number; totalMatches: number; sequential?: boolean }>
> {
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

    const matchCache = (await get("activityMatches")) ?? {};
    const entry = matchCache[stravaId];
    if (!entry || entry.peakIds.length === 0) {
      return {
        ok: false,
        error: "No matches cached — refresh the popup first",
      };
    }

    const processed = (await get("processed")) ?? {};
    const unprocessed = entry.peakIds.filter(
      (pid) => !processed[`${stravaId}:${pid}`],
    );
    if (unprocessed.length === 0) {
      return {
        ok: true,
        openedCount: 0,
        totalMatches: entry.peakIds.length,
      };
    }

    // Pre-flight session check.
    const loggedIn = await isPeakbaggerLoggedIn();
    if (!loggedIn) {
      return {
        ok: false,
        error:
          "Logged out of peakbagger — log in at peakbagger.com and try again",
      };
    }

    const isMultiPeak = entry.peakIds.length > 1;
    const activities = (await get("activities")) ?? [];
    const activity = activities.find((a) => a.id === stravaId);
    const activityName = activity?.name ?? "Trip";

    // Patch every payload's tripChoice based on its index in the
    // (summit-time-ordered) peakIds list. handleMatchBatch wrote
    // payloads with default { kind: "single" } tripChoice; for
    // multi-peak activities we override.
    const payloads = (await get("prefillPayloads")) ?? {};
    for (let i = 0; i < entry.peakIds.length; i++) {
      const peakId = entry.peakIds[i]!;
      const key = `${stravaId}:${peakId}`;
      const payload = payloads[key];
      if (!payload) continue;
      const tripChoice: TripChoice = !isMultiPeak
        ? { kind: "single" }
        : i === 0
          ? {
              kind: "new",
              name: activityName,
              nights: 0,
              seq: 1,
            }
          : { kind: "attach-latest", seq: i + 1 };
      payloads[key] = { ...payload, tripChoice };
    }
    await set("prefillPayloads", payloads);

    if (isMultiPeak) {
      // Sequential: open ONLY the first unprocessed tab. The chain
      // advances via handleAscentSaved in Step 5.
      const firstPeakId = unprocessed[0]!;
      if (!payloads[`${stravaId}:${firstPeakId}`]) {
        return {
          ok: false,
          error: `logAscents: prefill missing for ${stravaId}:${firstPeakId}`,
        };
      }
      await openOneTab(stravaId, firstPeakId, cid);
      void log("info", "Logged ascents — multi-peak sequential start", {
        stravaId,
        totalMatches: entry.peakIds.length,
        unprocessed: unprocessed.length,
      });
      return {
        ok: true,
        openedCount: 1,
        totalMatches: entry.peakIds.length,
        sequential: true,
      };
    }

    // Single-peak: existing parallel behavior.
    let openedCount = 0;
    for (const peakId of unprocessed) {
      const key = `${stravaId}:${peakId}`;
      if (!payloads[key]) {
        void log("warn", "logAscents: prefill payload missing", {
          stravaId,
          peakId,
        });
        continue;
      }
      await openOneTab(stravaId, peakId, cid);
      openedCount++;
    }

    void log("info", "Logged ascents — single-peak", {
      stravaId,
      openedCount,
      totalMatches: entry.peakIds.length,
    });
    return {
      ok: true,
      openedCount,
      totalMatches: entry.peakIds.length,
    };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleTripBaseline(msg: {
  stravaId?: unknown;
  priorMaxTripId?: unknown;
}): Promise<{ ok: true } | Err> {
  try {
    const stravaId = Number(msg.stravaId);
    const priorMaxTripId = Number(msg.priorMaxTripId);
    if (!Number.isFinite(stravaId) || stravaId <= 0) {
      return { ok: false, error: "trip-baseline: invalid stravaId" };
    }
    if (!Number.isFinite(priorMaxTripId) || priorMaxTripId < 0) {
      return { ok: false, error: "trip-baseline: invalid priorMaxTripId" };
    }
    const all = (await get("activityMatches")) ?? {};
    const entry = all[stravaId];
    if (!entry) {
      void log("warn", "trip-baseline: no activityMatches entry", { stravaId });
      return { ok: false, error: "no activityMatches entry" };
    }
    all[stravaId] = { ...entry, priorMaxTripId };
    await set("activityMatches", all);
    void log("info", "trip-baseline recorded", { stravaId, priorMaxTripId });
    return { ok: true };
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
      updated[key] = buildPrefill(track, m, activity, { kind: "single" }, matches);
    }
    await set("prefillPayloads", updated);

    // Open one tab per match, sequentially (so Chrome stages them
    // properly without overloading the tab strip). For each opened
    // tab, record a (tabId → {stravaId, peakId}) mapping in session
    // storage so the content script can recover the identity after
    // a post-save reload (peakbagger's POST→redirect strips URL
    // hashes, so the `#s2p=` token we embed in the URL only
    // survives the initial page load).
    const sessionPending = await getPendingTabSaves();
    for (const m of unprocessedMatches) {
      const url = `${PEAKBAGGER_ASCENT_URL}?pid=${m.peak.peakId}&cid=${cid}#s2p=${stravaId}`;
      const tab = await chrome.tabs.create({ url, active: false });
      if (tab.id !== undefined) {
        sessionPending[tab.id] = { stravaId, peakId: m.peak.peakId };
      }
    }
    await setPendingTabSaves(sessionPending);

    void log("info", "Processed activity", {
      stravaId,
      activityName: activity.name,
      matches: matches.length,
      opened: unprocessedMatches.length,
    });
    return {
      ok: true,
      openedCount: unprocessedMatches.length,
      totalMatches: matches.length,
    };
  } catch (e) {
    void log("error", "processActivity failed", {
      stravaId,
      error: errMessage(e),
    });
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

    void log("info", "Saved ascent", { stravaId, peakId, ascentId });

    // v0.3 multi-peak chain advance. If this activity is multi-peak
    // and has more unprocessed peaks, open the next tab so the user
    // doesn't have to click Log ascents again. Single-peak
    // activities skip this block.
    const matches = (await get("activityMatches"))?.[stravaId];
    if (matches && matches.peakIds.length > 1) {
      const nextPeakId = matches.peakIds.find(
        (pid) => !processed[`${stravaId}:${pid}`],
      );
      if (nextPeakId !== undefined) {
        const cid = await getClimberId();
        if (cid !== undefined) {
          await openOneTab(stravaId, nextPeakId, cid);
          void log("info", "Multi-peak chain advanced", {
            stravaId,
            nextPeakId,
          });
        } else {
          void log(
            "warn",
            "chain advance skipped — no climber ID",
            { stravaId },
          );
        }
      }
    }

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

    // Always set the hiddenActivities entry — works for unmatched
    // activities (no match cache) and matched alike.
    const hiddenActivities = (await get("hiddenActivities")) ?? {};
    hiddenActivities[stravaId] = { hiddenAt: Date.now() };
    await set("hiddenActivities", hiddenActivities);

    // If we have a match cache, ALSO write null-ascentId entries to
    // processed for un-saved peakIds so a future re-Open doesn't
    // re-open already-handled tabs.
    const activityMatches = (await get("activityMatches")) ?? {};
    const entry = activityMatches[stravaId];
    let hiddenCount = 0;
    if (entry) {
      const processed = (await get("processed")) ?? {};
      for (const peakId of entry.peakIds) {
        const key = `${stravaId}:${peakId}`;
        if (!processed[key]) {
          processed[key] = { processedAt: Date.now(), ascentId: null };
          hiddenCount++;
        }
      }
      await set("processed", processed);
    }
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

    // Clear the hiddenActivities entry.
    const hiddenActivities = (await get("hiddenActivities")) ?? {};
    const wasHidden = !!hiddenActivities[stravaId];
    if (wasHidden) {
      delete hiddenActivities[stravaId];
      await set("hiddenActivities", hiddenActivities);
    }

    // Also clear the null-ascentId processed entries written by Hide
    // (i.e. user-dismissed peaks). Preserve real ascentIds — those
    // are actual saves on peakbagger and shouldn't be forgotten.
    const activityMatches = (await get("activityMatches")) ?? {};
    const entry = activityMatches[stravaId];
    let unhiddenCount = wasHidden ? 1 : 0;
    if (entry) {
      const processed = (await get("processed")) ?? {};
      for (const peakId of entry.peakIds) {
        const key = `${stravaId}:${peakId}`;
        const rec = processed[key];
        if (rec && rec.ascentId === null) {
          delete processed[key];
          unhiddenCount++;
        }
      }
      await set("processed", processed);
    }
    return { ok: true, unhiddenCount };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function handleHideAllVisible(): Promise<
  Resp<{ hiddenCount: number }>
> {
  try {
    const activities = (await get("activities")) ?? [];
    const activityMatches = (await get("activityMatches")) ?? {};
    const processed = (await get("processed")) ?? {};
    const hiddenActivities = (await get("hiddenActivities")) ?? {};

    let hiddenCount = 0;
    for (const a of activities) {
      // Skip activities already hidden or fully done — they're not
      // visible in the default popup view, so "hide all visible"
      // shouldn't touch them.
      if (hiddenActivities[a.id]) continue;
      const matches = activityMatches[a.id];
      if (matches) {
        const allProcessed = matches.peakIds.every(
          (pid) => processed[`${a.id}:${pid}`],
        );
        if (allProcessed) continue;
      }

      hiddenActivities[a.id] = { hiddenAt: Date.now() };
      hiddenCount++;

      // Same as single-Hide: also write null-ascentId entries for
      // any matched peakIds not yet in processed, so re-Open later
      // doesn't re-open tabs we said to dismiss.
      if (matches) {
        for (const peakId of matches.peakIds) {
          const key = `${a.id}:${peakId}`;
          if (!processed[key]) {
            processed[key] = { processedAt: Date.now(), ascentId: null };
          }
        }
      }
    }

    if (hiddenCount > 0) {
      await set("hiddenActivities", hiddenActivities);
      await set("processed", processed);
      void log("info", "Hide-all-visible swept activities", { hiddenCount });
    }
    return { ok: true, hiddenCount };
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
    if (type === "matchBatch") {
      void handleMatchBatch({
        startIndex: Number(msg?.startIndex ?? 0),
        size: Number(msg?.size ?? 20),
        autoContinue: msg?.autoContinue !== false,
      })
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
        );
      return true;
    }
    if (type === "logAscents") {
      const stravaId = Number(msg?.stravaId);
      void handleLogAscents(stravaId)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: errMessage(e) }),
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
    if (type === "hideAllVisible") {
      void handleHideAllVisible().then(sendResponse).catch((e: unknown) =>
        sendResponse({ ok: false, error: errMessage(e) }),
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

    // Content-script-emitted signal (v0.3). Tab 1 of a multi-peak
    // chain captures the prior max TripDD option value before save
    // so tabs 2..N can disambiguate the newly-created trip.
    if (type === "trip-baseline") {
      void handleTripBaseline(msg).then(sendResponse).catch((e: unknown) =>
        sendResponse({ ok: false, error: errMessage(e) }),
      );
      return true;
    }

    // Content-script fallback: when peakbagger strips the URL hash
    // on post-save reload, the content script can't read stravaId
    // from #s2p=. It asks us for the mapping by sender tab id.
    if (type === "getTabMapping") {
      void handleGetTabMapping(_sender.tab?.id).then(sendResponse).catch(
        (e: unknown) => sendResponse({ ok: false, error: errMessage(e) }),
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

  // Clean up the per-tab pending-save mapping when a tab closes.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const pending = await getPendingTabSaves();
      if (pending[tabId]) {
        delete pending[tabId];
        await setPendingTabSaves(pending);
      }
    })();
  });

  // Periodic watchdog. Top-level registration so Chrome can wake the
  // SW for it after a sleep.
  chrome.alarms.create("s2p-watchdog", { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "s2p-watchdog") return;
    void runWatchdog();
  });

  (
    globalThis as unknown as {
      s2p: {
        devList: () => Promise<number>;
        devPeaks: (activityId: number) => Promise<number>;
        devMatch: (activityId: number) => Promise<number>;
        devNearest: (activityId: number, n?: number) => Promise<number>;
        runWatchdog: () => Promise<{
          staleTabSavesRemoved: number;
          staleProgressRemoved: number;
        }>;
      };
    }
  ).s2p = {
    devList: handleDevList,
    devPeaks: handleDevPeaks,
    devMatch: handleDevMatch,
    devNearest: handleDevNearest,
    runWatchdog,
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
