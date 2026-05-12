import { getClimberId } from "../../lib/storage";
import type { ActivitySummary } from "../../lib/models";

type ActivityState = "unmatched" | "pending" | "done";
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
    }
  | { ok: false; error: string };

async function send(message: unknown): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}

let showHidden = false;

export async function init(): Promise<void> {
  const cid = await getClimberId();
  el<HTMLElement>("cid-warning").hidden = cid !== undefined;

  await renderActivities();

  el<HTMLButtonElement>("refresh-btn").addEventListener("click", () => {
    void handleRefresh();
  });

  el<HTMLInputElement>("show-hidden").addEventListener("change", (e) => {
    showHidden = (e.target as HTMLInputElement).checked;
    void renderActivities();
  });
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
  const openBtn = li.querySelector<HTMLButtonElement>(".open-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      void handleOpen(activity.id, openBtn, rowStatus);
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
  if (activity.state === "done") {
    return `<button class="unhide-btn" type="button" data-strava-id="${activity.id}">Unhide</button>`;
  }
  // unmatched OR pending
  return `
    <button class="open-btn" type="button" data-strava-id="${activity.id}">Open</button>
    <button class="hide-btn" type="button" data-strava-id="${activity.id}">Hide</button>
  `;
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

async function handleOpen(
  stravaId: number,
  btn: HTMLButtonElement,
  rowStatus: HTMLElement,
): Promise<void> {
  btn.disabled = true;
  rowStatus.textContent = "Opening…";

  try {
    const res = await send({ type: "processActivity", stravaId });
    if (!res.ok) {
      rowStatus.textContent = res.error;
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
