import { getClimberId } from "../../lib/storage";
import type { ActivitySummary } from "../../lib/models";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup is missing #${id}`);
  return node as T;
}

function setStatus(message: string): void {
  el<HTMLElement>("status").textContent = message;
}

type Response =
  | { ok: true; activities?: ActivitySummary[]; count?: number; openedCount?: number }
  | { ok: false; error: string };

async function send(message: unknown): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}

export async function init(): Promise<void> {
  const cid = await getClimberId();
  el<HTMLElement>("cid-warning").hidden = cid !== undefined;

  await renderActivities();

  el<HTMLButtonElement>("refresh-btn").addEventListener("click", () => {
    void handleRefresh();
  });
}

async function renderActivities(): Promise<void> {
  const res = await send({ type: "getActivities" });
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

function buildRow(activity: ActivitySummary): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "activity";
  li.innerHTML = `
    <div class="activity-meta">
      <span class="activity-date">${escapeHtml(activity.start.slice(0, 10))}</span>
      <span class="activity-sport">${escapeHtml(activity.sportType)}</span>
    </div>
    <div class="activity-name">${escapeHtml(activity.name)}</div>
    <div class="activity-actions">
      <button class="open-btn" type="button" data-strava-id="${activity.id}">Open</button>
      <p class="row-status" role="status" aria-live="polite"></p>
    </div>
  `;
  const btn = li.querySelector<HTMLButtonElement>(".open-btn")!;
  const rowStatus = li.querySelector<HTMLElement>(".row-status")!;
  btn.addEventListener("click", () => {
    void handleOpen(activity.id, btn, rowStatus);
  });
  return li;
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
      rowStatus.textContent = "No peak matches";
    } else {
      const n = res.openedCount!;
      rowStatus.textContent = `Opened ${n} tab${n === 1 ? "" : "s"}`;
    }
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
