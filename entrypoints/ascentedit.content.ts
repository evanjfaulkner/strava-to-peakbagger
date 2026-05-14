import type { PrefillPayload, TripChoice } from "../lib/models";

export type TextField =
  | "date"
  | "suffixText"
  | "journalText"
  | "externalUrl"
  | "startFt"
  | "endFt"
  | "gainFt"
  | "upMi"
  | "dnMi"
  | "upHr"
  | "upMin"
  | "dnHr"
  | "dnMin";

// PrefillPayload field → peakbagger Add-Ascent form field name=
// AscentTypeRBL is a radio group, handled separately below.
// pid is in the URL query, not a form input.
export const FIELD_MAP: Readonly<Record<TextField, string>> = {
  date: "DateText",
  suffixText: "SuffixText",
  journalText: "JournalText",
  externalUrl: "URLTB",
  startFt: "StartFt",
  endFt: "EndFt",
  gainFt: "GainFt",
  upMi: "UpMi",
  dnMi: "DnMi",
  upHr: "UpHr",
  upMin: "UpMin",
  dnHr: "DnHr",
  dnMin: "DnMin",
};

const SAVED_MARKER = "Saved Successfully";

// ============================================================
// Trip handling (v0.3)
// ============================================================

/**
 * Highest positive integer value present in a TripDD <select>.
 * Returns 0 when the select has only sentinel values (0, -1, -2).
 */
export function currentMaxTripId(select: HTMLSelectElement): number {
  let max = 0;
  for (const opt of Array.from(select.options)) {
    const v = Number(opt.value);
    if (Number.isInteger(v) && v > max) max = v;
  }
  return max;
}

/**
 * Highest positive integer value in the select that's strictly
 * greater than `prior`. Returns null when none exists.
 */
export function pickLatestTripIdAfter(
  select: HTMLSelectElement,
  prior: number,
): number | null {
  let best: number | null = null;
  for (const opt of Array.from(select.options)) {
    const v = Number(opt.value);
    if (Number.isInteger(v) && v > prior && (best === null || v > best)) {
      best = v;
    }
  }
  return best;
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setTextInputByName(name: string, value: string): void {
  const el = document.querySelector(`[name="${name}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!el) {
    console.warn(`[s2p] form field [name="${name}"] not found`);
    return;
  }
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function applyTripChoice(
  choice: TripChoice,
  stravaId: number,
): Promise<void> {
  const ddl = document.querySelector<HTMLSelectElement>(
    'select[name="TripDD"]',
  );
  if (!ddl) {
    console.warn("[s2p] TripDD select not found; skipping trip fields");
    return;
  }

  if (choice.kind === "single") {
    setSelectValue(ddl, "0");
    return;
  }

  if (choice.kind === "new") {
    // Snapshot the prior max BEFORE the user saves, so tabs 2..N can
    // find the newly-created trip later as the highest positive
    // option whose value > priorMaxTripId.
    const priorMaxTripId = currentMaxTripId(ddl);
    try {
      await chrome.runtime.sendMessage({
        type: "trip-baseline",
        stravaId,
        priorMaxTripId,
      });
    } catch (e) {
      console.warn("[s2p] trip-baseline send failed:", e);
    }
    setSelectValue(ddl, "-1");
    setTextInputByName("TripNameText", choice.name);
    setTextInputByName("TripNightsText", String(choice.nights));
    setTextInputByName("TripSeqText", String(choice.seq));
    return;
  }

  // attach-latest
  const stored = await chrome.storage.local.get("activityMatches");
  const all = stored.activityMatches as
    | Record<number, { priorMaxTripId?: number }>
    | undefined;
  const prior = all?.[stravaId]?.priorMaxTripId ?? 0;
  const tripId = pickLatestTripIdAfter(ddl, prior);
  if (tripId === null) {
    console.warn(
      `[s2p] attach-latest: no TripDD option > ${prior}; leaving TripDD=0`,
    );
    return;
  }
  setSelectValue(ddl, String(tripId));
  setTextInputByName("TripSeqText", String(choice.seq));
}

export async function init(): Promise<void> {
  const url = new URL(window.location.href);
  const pidStr = url.searchParams.get("pid");
  let pid = pidStr ? Number(pidStr) : NaN;
  // Peakbagger uses negative peakIds for some unofficial / user-
  // contributed peaks (e.g. pid=-200643). Accept any finite integer.
  if (!Number.isFinite(pid)) {
    console.debug("[s2p] no pid in URL; content script no-op");
    return;
  }

  // Prefer the URL hash for stravaId (set by the popup when opening
  // the tab). Falls back to the SW's per-tab mapping for the
  // post-save reload case: peakbagger's POST→redirect strips the
  // hash, so we can't read it after the form submits.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const stravaIdStr = hashParams.get("s2p");
  const stravaIdFromHash = stravaIdStr ? Number(stravaIdStr) : NaN;

  let stravaId: number;
  if (Number.isFinite(stravaIdFromHash) && stravaIdFromHash > 0) {
    stravaId = stravaIdFromHash;
  } else {
    const res = (await chrome.runtime.sendMessage({
      type: "getTabMapping",
    })) as { ok: true; mapping: { stravaId: number; peakId: number } | null } | { ok: false; error: string };
    if (!res?.ok || !res.mapping) {
      console.debug(
        "[s2p] no #s2p hash and no SW tab mapping; content script no-op",
      );
      return;
    }
    stravaId = res.mapping.stravaId;
    // The SW mapping is authoritative for both stravaId and pid —
    // use it for pid too in case our URL parse is off (e.g. ASP.NET
    // postback adds aid= but keeps pid=).
    pid = res.mapping.peakId;
  }

  const stored = await chrome.storage.local.get("prefillPayloads");
  const allPayloads =
    (stored.prefillPayloads as Record<string, PrefillPayload> | undefined) ??
    {};
  const key = `${stravaId}:${pid}`;
  const payload = allPayloads[key];
  if (!payload) {
    console.warn(
      `[s2p] no prefill payload for ${key}; the popup didn't write one`,
    );
    return;
  }

  // Post-save state check FIRST. If the user has already clicked Save
  // and peakbagger reloaded the page with the success marker, we send
  // the ascent-saved message and exit without re-filling.
  const subtitle = document.querySelector("#SubTitle")?.textContent ?? "";
  if (subtitle.includes(SAVED_MARKER)) {
    const aidStr = url.searchParams.get("aid");
    const ascentId =
      aidStr && Number.isFinite(Number(aidStr)) ? Number(aidStr) : null;
    await chrome.runtime.sendMessage({
      type: "ascent-saved",
      stravaId,
      peakId: pid,
      ascentId,
    });
    console.log(
      `[s2p] ascent saved for activity ${stravaId}, peak ${pid}, ascentId ${ascentId ?? "<unknown>"}`,
    );
    return;
  }

  // Fill all text/textarea fields.
  let filled = 0;
  for (const [field, name] of Object.entries(FIELD_MAP) as Array<
    [TextField, string]
  >) {
    const el = document.querySelector(`[name="${name}"]`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!el) {
      console.warn(`[s2p] form field [name="${name}"] not found`);
      continue;
    }
    el.value = String(payload[field]);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled++;
  }

  // AscentTypeRBL radio: click the "S" (Successful summit) option.
  const sRadio = document.querySelector<HTMLInputElement>(
    'input[name="AscentTypeRBL"][value="S"]',
  );
  if (!sRadio) {
    console.warn('[s2p] AscentTypeRBL radio with value="S" not found');
  } else {
    sRadio.checked = true;
    sRadio.dispatchEvent(new Event("click", { bubbles: true }));
    sRadio.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Trip handling. Default to "single" for pre-v0.3 payloads in
  // storage that don't have a tripChoice field yet.
  const choice: TripChoice = payload.tripChoice ?? { kind: "single" };
  await applyTripChoice(choice, stravaId);

  console.log(
    `[s2p] prefilled ascentedit form for activity ${stravaId}, peak ${pid} (${filled}/${Object.keys(FIELD_MAP).length} text fields, trip=${choice.kind})`,
  );
}

export default defineContentScript({
  matches: ["https://*.peakbagger.com/climber/ascentedit.aspx*"],
  runAt: "document_idle",
  main: init,
});
