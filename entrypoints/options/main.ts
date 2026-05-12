import {
  getSettings,
  getStravaCreds,
  setSettings,
  setStravaCreds,
} from "../../lib/storage";
import type { Settings } from "../../lib/storage";

const STATUS_CLEAR_MS = 4000;

type Field = "clientId" | "clientSecret" | "horizM" | "vertM" | "lookbackDays" | "blacklist";

function el<T extends HTMLElement>(id: Field | "status" | "options-form"): T {
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

export async function init(): Promise<void> {
  const form = el<HTMLFormElement>("options-form");

  const [settings, creds] = await Promise.all([
    getSettings(),
    getStravaCreds(),
  ]);

  el<HTMLInputElement>("clientId").value = creds.clientId;
  el<HTMLInputElement>("clientSecret").value = creds.clientSecret;
  el<HTMLInputElement>("horizM").value = String(settings.horizM);
  el<HTMLInputElement>("vertM").value = String(settings.vertM);
  el<HTMLInputElement>("lookbackDays").value = String(settings.lookbackDays);
  el<HTMLTextAreaElement>("blacklist").value = settings.blacklist.join("\n");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void handleSubmit();
  });
}

async function handleSubmit(): Promise<void> {
  const clientId = el<HTMLInputElement>("clientId").value.trim();
  const clientSecret = el<HTMLInputElement>("clientSecret").value.trim();

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
