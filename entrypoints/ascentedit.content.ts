import type { PrefillPayload } from "../lib/models";

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

export async function init(): Promise<void> {
  const url = new URL(window.location.href);
  const pidStr = url.searchParams.get("pid");
  const pid = pidStr ? Number(pidStr) : NaN;
  // Peakbagger uses negative peakIds for some unofficial / user-
  // contributed peaks (e.g. pid=-200643). Accept any finite integer.
  if (!Number.isFinite(pid)) {
    console.debug("[s2p] no pid in URL; content script no-op");
    return;
  }

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const stravaIdStr = hashParams.get("s2p");
  const stravaId = stravaIdStr ? Number(stravaIdStr) : NaN;
  if (!Number.isFinite(stravaId) || stravaId <= 0) {
    console.debug(
      "[s2p] no #s2p=<stravaId> in URL hash; content script no-op",
    );
    return;
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

  console.log(
    `[s2p] prefilled ascentedit form for activity ${stravaId}, peak ${pid} (${filled}/${Object.keys(FIELD_MAP).length} text fields)`,
  );
}

export default defineContentScript({
  matches: ["https://*.peakbagger.com/climber/ascentedit.aspx*"],
  runAt: "document_idle",
  main: init,
});
