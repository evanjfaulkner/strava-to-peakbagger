import {
  getClimberId,
  getMatchSession,
  setMatchSession,
} from "../../lib/storage";
import type { ActivitySummary } from "../../lib/models";

type ActivityState =
  | "unmatched"
  | "no-match"
  | "pending"
  | "done"
  | "hidden";
type EnrichedActivity = ActivitySummary & {
  state: ActivityState;
  matchedPeakIds?: number[];
  processedPeakIds?: number[];
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup is missing #${id}`);
  return node as T;
}

function setStatus(message: string): void {
  el<HTMLElement>("status").textContent = message;
}

type Response =
  | {
      ok: true;
      activities?: EnrichedActivity[];
      count?: number;
      openedCount?: number;
      totalMatches?: number;
      hiddenCount?: number;
      unhiddenCount?: number;
      sessionId?: string;
      totalScanned?: number;
      endIndex?: number;
      reason?: "found-pending" | "rate-limited" | "exhausted" | "manual-stop";
    }
  | { ok: false; error: string };

const BATCH_SIZE = 20;

async function send(message: unknown): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}

let showHidden = false;

// Per-popup-session cumulative counters. Reset on each init().
let sessionScanned = 0;
let sessionMatches = 0;
let batchInFlight = false;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

function todayLocalISO(): string {
  return new Date().toLocaleDateString("sv-SE"); // "YYYY-MM-DD"
}

function setProgress(text: string): void {
  const node = document.getElementById("match-progress");
  if (node) node.textContent = text;
}

function updateProgressDisplay(): void {
  if (sessionScanned === 0 && sessionMatches === 0) {
    setProgress("");
    return;
  }
  setProgress(
    `Scanned ${sessionScanned} activit${sessionScanned === 1 ? "y" : "ies"} · Found ${sessionMatches} match${sessionMatches === 1 ? "" : "es"}`,
  );
}

export async function init(): Promise<void> {
  // Reset per-session state.
  sessionScanned = 0;
  sessionMatches = 0;
  showHidden = false;
  batchInFlight = false;
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  const cid = await getClimberId();
  el<HTMLElement>("cid-warning").hidden = cid !== undefined;

  // Show cached state immediately so the popup never looks blank.
  await renderActivities();

  el<HTMLButtonElement>("refresh-btn").addEventListener("click", () => {
    void handleRefresh();
  });

  el<HTMLInputElement>("show-hidden").addEventListener("change", (e) => {
    showHidden = (e.target as HTMLInputElement).checked;
    void renderActivities();
  });

  const hideAllBtn = document.getElementById("hide-all-btn");
  if (hideAllBtn instanceof HTMLButtonElement) {
    hideAllBtn.addEventListener("click", () => {
      void handleHideAll();
    });
  }

  const loadMoreBtn = document.getElementById("load-more-btn");
  if (loadMoreBtn instanceof HTMLButtonElement) {
    loadMoreBtn.addEventListener("click", () => {
      void handleLoadMore();
    });
  }

  // Listen for the SW's streaming batch events.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    if (m.type === "matchBatch:item") void handleBatchItem(msg);
    else if (m.type === "matchBatch:done") void handleBatchDone(msg);
  });

  // Auto-trigger refresh + first batch on first popup open of the
  // local day. Fires in the background; init() returns immediately.
  void maybeAutoTrigger();
}

async function maybeAutoTrigger(): Promise<void> {
  const today = todayLocalISO();
  const session = await getMatchSession();
  if (session?.lastAutoRefreshDay === today) return;

  batchInFlight = true;
  updateLoadMoreButton({ disabled: true, text: "Loading…" });

  try {
    const refreshRes = await send({ type: "refreshActivities" });
    if (!refreshRes.ok) {
      setStatus(`Refresh failed: ${friendlyError(refreshRes.error)}`);
      return;
    }
    // Auto-trigger always starts from index 0 of the cached
    // activities list (which is sorted by start desc, so new
    // activities sit at the top). The activityMatches cache makes
    // walking past already-scanned entries instant — only new
    // unmatched ones run the matcher.
    await setMatchSession({
      lastAutoRefreshDay: today,
      lastBatchEndIndex: 0,
    });
    await renderActivities();
    await send({
      type: "matchBatch",
      startIndex: 0,
      size: BATCH_SIZE,
      autoContinue: true,
    });
  } finally {
    batchInFlight = false;
  }
}

async function handleBatchItem(msg: unknown): Promise<void> {
  const m = msg as {
    peakCount?: number;
    addedPendingRow?: boolean;
    totalScanned?: number;
  };
  sessionScanned += 1;
  // Count only matches that produce visible (pending) rows so the
  // counter and the list stay in sync. An already-done match
  // increments sessionScanned but not sessionMatches.
  if (m.addedPendingRow) sessionMatches += 1;
  updateProgressDisplay();
  if (m.addedPendingRow) {
    await renderActivities();
  }
}

async function handleBatchDone(msg: unknown): Promise<void> {
  batchInFlight = false;
  const m = msg as {
    endIndex?: number;
    reason?: "found-pending" | "rate-limited" | "exhausted" | "manual-stop";
  };
  if (typeof m.endIndex === "number") {
    const session = await getMatchSession();
    await setMatchSession({
      lastAutoRefreshDay: session?.lastAutoRefreshDay ?? todayLocalISO(),
      lastBatchEndIndex: m.endIndex,
    });
  }
  // Final state for Load more button.
  if (m.reason === "exhausted") {
    updateLoadMoreButton({
      disabled: true,
      text: "No more activities",
      visible: true,
    });
  } else if (m.reason === "rate-limited") {
    const ts = (await getStravaNextRetryAt()) ?? Date.now() + 60_000;
    updateLoadMoreButton({
      disabled: true,
      text: `Rate limited — try again at ${fmtHHMM(ts)}`,
      visible: true,
    });
    scheduleCooldownRecheck(ts);
  } else {
    updateLoadMoreButton({ disabled: false, text: "Load more", visible: true });
  }
}

async function handleLoadMore(): Promise<void> {
  if (batchInFlight) return;
  batchInFlight = true;
  updateLoadMoreButton({ disabled: true, text: "Loading…" });
  try {
    const session = await getMatchSession();
    await send({
      type: "matchBatch",
      startIndex: session?.lastBatchEndIndex ?? 0,
      size: BATCH_SIZE,
      autoContinue: true,
    });
  } finally {
    // batchInFlight is cleared by handleBatchDone.
  }
}

function updateLoadMoreButton(opts: {
  disabled: boolean;
  text: string;
  visible?: boolean;
}): void {
  const btn = document.getElementById("load-more-btn");
  if (!(btn instanceof HTMLButtonElement)) return;
  btn.disabled = opts.disabled;
  btn.textContent = opts.text;
  if (opts.visible !== undefined) btn.hidden = !opts.visible;
}

async function getStravaNextRetryAt(): Promise<number | null> {
  try {
    const stored = await chrome.storage.session.get("stravaNextRetryAt");
    const v = (stored as Record<string, unknown>)["stravaNextRetryAt"];
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

function fmtHHMM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function scheduleCooldownRecheck(ts: number): void {
  if (cooldownTimer !== null) clearTimeout(cooldownTimer);
  const delay = Math.max(1000, ts - Date.now() + 5000);
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    updateLoadMoreButton({
      disabled: false,
      text: "Load more",
      visible: true,
    });
  }, delay);
}

async function renderActivities(): Promise<void> {
  const res = await send({ type: "getActivities", showHidden });
  const list = el<HTMLUListElement>("activity-list");
  list.replaceChildren();

  if (!res.ok) {
    setStatus(`Failed to load activities: ${res.error}`);
    el<HTMLElement>("empty-state").hidden = true;
    return;
  }

  const activities = res.activities ?? [];
  el<HTMLElement>("empty-state").hidden = activities.length > 0;

  for (const activity of activities) {
    list.appendChild(buildRow(activity));
  }
}

function buildRow(activity: EnrichedActivity): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `activity ${activity.state}`;

  const badge = renderBadge(activity);
  const actionButtons = renderActionButtons(activity);

  li.innerHTML = `
    <div class="activity-meta">
      <span class="activity-date">${escapeHtml(activity.start.slice(0, 10))}</span>
      <span class="activity-sport">${escapeHtml(activity.sportType)}</span>
      ${badge}
    </div>
    <div class="activity-name">${escapeHtml(activity.name)}</div>
    <div class="activity-actions">
      ${actionButtons}
      <p class="row-status" role="status" aria-live="polite"></p>
    </div>
  `;

  const rowStatus = li.querySelector<HTMLElement>(".row-status")!;
  const logBtn = li.querySelector<HTMLButtonElement>(".log-btn");
  if (logBtn) {
    logBtn.addEventListener("click", () => {
      void handleLog(activity.id, logBtn, rowStatus);
    });
  }
  const hideBtn = li.querySelector<HTMLButtonElement>(".hide-btn");
  if (hideBtn) {
    hideBtn.addEventListener("click", () => {
      void handleHide(activity.id, hideBtn, rowStatus);
    });
  }
  const unhideBtn = li.querySelector<HTMLButtonElement>(".unhide-btn");
  if (unhideBtn) {
    unhideBtn.addEventListener("click", () => {
      void handleUnhide(activity.id, unhideBtn, rowStatus);
    });
  }
  return li;
}

function renderBadge(activity: EnrichedActivity): string {
  if (activity.state !== "pending") return "";
  const total = activity.matchedPeakIds?.length ?? 0;
  const done = activity.processedPeakIds?.length ?? 0;
  return `<span class="match-badge">${done}/${total} saved</span>`;
}

function renderActionButtons(activity: EnrichedActivity): string {
  if (activity.state === "done" || activity.state === "hidden") {
    return `<button class="unhide-btn" type="button" data-strava-id="${activity.id}">Unhide</button>`;
  }
  // unmatched OR pending
  return `
    <button class="log-btn" type="button" data-strava-id="${activity.id}">Log ascents</button>
    <button class="hide-btn" type="button" data-strava-id="${activity.id}">Hide</button>
  `;
}

async function handleHideAll(): Promise<void> {
  const btn = el<HTMLButtonElement>("hide-all-btn");
  btn.disabled = true;
  const previousText = btn.textContent ?? "Hide all";
  btn.textContent = "Hiding…";

  try {
    const res = await send({ type: "hideAllVisible" });
    if (!res.ok) {
      setStatus(`Hide all failed: ${res.error}`);
    } else {
      const n = res.hiddenCount ?? 0;
      setStatus(n === 0 ? "Nothing to hide" : `Hid ${n} activit${n === 1 ? "y" : "ies"}`);
    }
    await renderActivities();
  } finally {
    btn.textContent = previousText;
    btn.disabled = false;
  }
}

async function handleRefresh(): Promise<void> {
  const btn = el<HTMLButtonElement>("refresh-btn");
  btn.disabled = true;
  setStatus("Refreshing…");

  try {
    const res = await send({ type: "refreshActivities" });
    if (!res.ok) {
      setStatus(`Refresh failed: ${res.error}`);
    } else {
      setStatus("");
    }
    await renderActivities();
  } finally {
    btn.disabled = false;
  }
}

async function handleLog(
  stravaId: number,
  btn: HTMLButtonElement,
  rowStatus: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  rowStatus.textContent = "Opening…";

  try {
    const res = await send({ type: "logAscents", stravaId });
    if (!res.ok) {
      if (/logged out/i.test(res.error)) {
        rowStatus.innerHTML =
          'Logged out — <a href="https://peakbagger.com/Climber/Login.aspx" target="_blank" rel="noopener">log in</a> and try again';
      } else {
        rowStatus.textContent = friendlyError(res.error);
      }
    } else if ((res.openedCount ?? 0) === 0) {
      if ((res.totalMatches ?? 0) === 0) {
        rowStatus.textContent = "No peak matches";
      } else {
        rowStatus.textContent = "All matches already saved";
      }
    } else {
      const n = res.openedCount!;
      rowStatus.textContent = `Opened ${n} tab${n === 1 ? "" : "s"}`;
    }
  } finally {
    btn.disabled = false;
  }
}

function friendlyError(raw: string): string {
  // Strava rate-limit errors carry an ISO timestamp; render it as
  // local HH:MM so the operator knows when to try again.
  const m = raw.match(/rate limit.*?retry after (\S+)/i);
  if (m && m[1]) {
    const d = new Date(m[1]);
    if (!Number.isNaN(d.getTime())) {
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `Rate limited — try again at ${hh}:${mm}`;
    }
  }
  return raw;
}

async function handleHide(
  stravaId: number,
  btn: HTMLButtonElement,
  rowStatus: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  rowStatus.textContent = "Hiding…";

  try {
    const res = await send({ type: "markActivityHidden", stravaId });
    if (!res.ok) {
      rowStatus.textContent = res.error;
      return;
    }
    await renderActivities();
  } finally {
    btn.disabled = false;
  }
}

async function handleUnhide(
  stravaId: number,
  btn: HTMLButtonElement,
  rowStatus: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  rowStatus.textContent = "Unhiding…";

  try {
    const res = await send({ type: "markActivityUnhidden", stravaId });
    if (!res.ok) {
      rowStatus.textContent = res.error;
      return;
    }
    await renderActivities();
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (!import.meta.env.VITEST) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
}
