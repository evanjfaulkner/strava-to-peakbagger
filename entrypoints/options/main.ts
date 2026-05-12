import { connectStrava, isConnected } from "../../lib/oauth";
import {
  get,
  getClimberId,
  getSettings,
  getStravaCreds,
  setClimberId,
  setSettings,
  setStravaCreds,
} from "../../lib/storage";
import type { Settings } from "../../lib/storage";

const STATUS_CLEAR_MS = 4000;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`options page is missing #${id}`);
  return node as T;
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(message: string, autoClear = true): void {
  const status = el<HTMLElement>("status");
  status.textContent = message;
  if (statusTimer !== null) clearTimeout(statusTimer);
  if (autoClear && message !== "") {
    statusTimer = setTimeout(() => {
      status.textContent = "";
      statusTimer = null;
    }, STATUS_CLEAR_MS);
  }
}

function setConnectStatus(message: string): void {
  el<HTMLElement>("connect-status").textContent = message;
}

function parseIntInRange(
  raw: string,
  min: number,
  max: number,
): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function updateConnectButtonEnabled(): void {
  const cid = el<HTMLInputElement>("clientId").value.trim();
  const secret = el<HTMLInputElement>("clientSecret").value.trim();
  const btn = el<HTMLButtonElement>("connect-btn");
  btn.disabled = !(cid && secret);
}

function renderConnected(
  firstname: string | undefined,
  lastname: string | undefined,
  athleteId: number | undefined,
): void {
  const name = [firstname, lastname].filter(Boolean).join(" ") || "Strava athlete";
  el<HTMLElement>("athlete-name").textContent = name;
  el<HTMLElement>("athlete-id").textContent =
    athleteId !== undefined ? String(athleteId) : "—";
  el<HTMLElement>("connected-block").hidden = false;
  el<HTMLButtonElement>("connect-btn").textContent = "Reconnect";
}

export async function init(): Promise<void> {
  const form = el<HTMLFormElement>("options-form");

  const [settings, creds, climberId] = await Promise.all([
    getSettings(),
    getStravaCreds(),
    getClimberId(),
  ]);

  el<HTMLInputElement>("clientId").value = creds.clientId;
  el<HTMLInputElement>("clientSecret").value = creds.clientSecret;
  el<HTMLInputElement>("climberId").value =
    climberId !== undefined ? String(climberId) : "";
  el<HTMLInputElement>("horizM").value = String(settings.horizM);
  el<HTMLInputElement>("vertM").value = String(settings.vertM);
  el<HTMLInputElement>("lookbackDays").value = String(settings.lookbackDays);
  el<HTMLTextAreaElement>("blacklist").value = settings.blacklist.join("\n");

  updateConnectButtonEnabled();
  el<HTMLInputElement>("clientId").addEventListener(
    "input",
    updateConnectButtonEnabled,
  );
  el<HTMLInputElement>("clientSecret").addEventListener(
    "input",
    updateConnectButtonEnabled,
  );

  if (await isConnected()) {
    const strava = await get("strava");
    renderConnected(
      strava?.athleteFirstname,
      strava?.athleteLastname,
      strava?.athleteId,
    );
  }

  el<HTMLButtonElement>("connect-btn").addEventListener("click", () => {
    void handleConnect();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void handleSubmit();
  });
}

async function handleConnect(): Promise<void> {
  const btn = el<HTMLButtonElement>("connect-btn");
  btn.disabled = true;
  setConnectStatus("Connecting…");

  try {
    const result = await connectStrava();
    setConnectStatus("");
    renderConnected(result.firstname, result.lastname, result.athleteId);
  } catch (e) {
    setConnectStatus(e instanceof Error ? e.message : String(e));
  } finally {
    updateConnectButtonEnabled();
  }
}

async function handleSubmit(): Promise<void> {
  const clientId = el<HTMLInputElement>("clientId").value.trim();
  const clientSecret = el<HTMLInputElement>("clientSecret").value.trim();

  const climberIdRaw = el<HTMLInputElement>("climberId").value.trim();
  let climberId: number | undefined;
  if (climberIdRaw !== "") {
    const parsed = parseIntInRange(climberIdRaw, 1, 999_999_999);
    if (parsed === null) {
      setStatus("Invalid: climberId must be a positive integer");
      return;
    }
    climberId = parsed;
  }

  const horizM = parseIntInRange(el<HTMLInputElement>("horizM").value, 1, 500);
  if (horizM === null) {
    setStatus("Invalid: horizM must be an integer between 1 and 500");
    return;
  }

  const vertM = parseIntInRange(el<HTMLInputElement>("vertM").value, 1, 500);
  if (vertM === null) {
    setStatus("Invalid: vertM must be an integer between 1 and 500");
    return;
  }

  const lookbackDays = parseIntInRange(
    el<HTMLInputElement>("lookbackDays").value,
    1,
    3650,
  );
  if (lookbackDays === null) {
    setStatus("Invalid: lookbackDays must be an integer between 1 and 3650");
    return;
  }

  const blacklist = el<HTMLTextAreaElement>("blacklist")
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const next: Settings = { horizM, vertM, lookbackDays, blacklist };

  await setStravaCreds({ clientId, clientSecret });
  await setClimberId(climberId);
  await setSettings(next);

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  setStatus(`Saved ${hh}:${mm}:${ss}`);
}

if (!import.meta.env.VITEST) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
}
