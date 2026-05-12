// @vitest-environment happy-dom
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PrefillPayload } from "../lib/models";
import { installFakeChromeStorage } from "./fakeChromeStorage";

// Stub WXT's defineContentScript auto-import BEFORE importing the
// content-script module. defineContentScript runs at module top level
// and would throw a ReferenceError in vitest without this stub.
(globalThis as unknown as { defineContentScript: (c: unknown) => unknown }).defineContentScript =
  (config) => config;

// Dynamic import so the stub above is in place when the content-script
// module evaluates.
let init: () => Promise<void>;

beforeAll(async () => {
  const mod = await import("../entrypoints/ascentedit.content");
  init = mod.init;
});

const STRAVA_ID = 987654321;
const PEAK_ID = 12345;
const SAMPLE_PAYLOAD: PrefillPayload = {
  pid: PEAK_ID,
  date: "2026-04-15",
  ascentTypeRBL: "S",
  journalText: "",
  suffixText: "11:30",
  externalUrl: `https://www.strava.com/activities/${STRAVA_ID}`,
  startFt: 3281,
  endFt: 3281,
  gainFt: 1640,
  upMi: 0.7,
  dnMi: 0.7,
  upHr: 1,
  upMin: 30,
  dnHr: 1,
  dnMin: 30,
};

function setUrl(href: string): void {
  Object.defineProperty(window, "location", {
    value: new URL(href),
    writable: true,
    configurable: true,
  });
}

function buildPeakbaggerForm(
  opts: { withSaved?: boolean; omit?: Set<string> } = {},
): void {
  const omit = opts.omit ?? new Set<string>();
  const inputs: string[] = [];
  const textInputs = [
    "DateText",
    "SuffixText",
    "URLTB",
    "StartFt",
    "EndFt",
    "GainFt",
    "UpMi",
    "DnMi",
    "UpHr",
    "UpMin",
    "DnHr",
    "DnMin",
  ];
  for (const name of textInputs) {
    if (omit.has(name)) continue;
    inputs.push(`<input name="${name}" type="text" />`);
  }
  if (!omit.has("JournalText")) {
    inputs.push(`<textarea name="JournalText"></textarea>`);
  }
  if (!omit.has("AscentTypeRBL")) {
    inputs.push(`<input name="AscentTypeRBL" type="radio" value="S" />`);
    inputs.push(`<input name="AscentTypeRBL" type="radio" value="A" />`);
  }
  const subtitle = opts.withSaved
    ? '<span id="SubTitle">Ascent — Saved Successfully</span>'
    : "";
  document.body.innerHTML = `<form>${inputs.join("\n")}${subtitle}</form>`;
}

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(() => {
  storage = installFakeChromeStorage();
  storage.bag["prefillPayloads"] = {
    [`${STRAVA_ID}:${PEAK_ID}`]: SAMPLE_PAYLOAD,
  };
  document.body.innerHTML = "";
});

function inputByName(name: string): HTMLInputElement {
  const el = document.querySelector(`input[name="${name}"]`);
  if (!(el instanceof HTMLInputElement))
    throw new Error(`no input named ${name}`);
  return el;
}

function textareaByName(name: string): HTMLTextAreaElement {
  const el = document.querySelector(`textarea[name="${name}"]`);
  if (!(el instanceof HTMLTextAreaElement))
    throw new Error(`no textarea named ${name}`);
  return el;
}

describe("init — early returns", () => {
  it("no-ops when URL has no pid", async () => {
    setUrl("https://www.peakbagger.com/climber/ascentedit.aspx");
    buildPeakbaggerForm();

    await init();

    expect(inputByName("DateText").value).toBe("");
  });

  it("no-ops when URL has no #s2p hash", async () => {
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}`,
    );
    buildPeakbaggerForm();

    await init();

    expect(inputByName("DateText").value).toBe("");
  });

  it("warns and no-ops when no payload exists for the (stravaId, pid) pair", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=99999`,
    );
    buildPeakbaggerForm();

    await init();

    expect(inputByName("DateText").value).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`no prefill payload for 99999:${PEAK_ID}`),
    );
  });
});

describe("init — happy path pre-fill", () => {
  beforeEach(() => {
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}&cid=42#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm();
  });

  it("fills every text/textarea field by name", async () => {
    await init();

    expect(inputByName("DateText").value).toBe("2026-04-15");
    expect(inputByName("SuffixText").value).toBe("11:30");
    expect(textareaByName("JournalText").value).toBe("");
    expect(inputByName("URLTB").value).toBe(
      `https://www.strava.com/activities/${STRAVA_ID}`,
    );
    expect(inputByName("StartFt").value).toBe("3281");
    expect(inputByName("EndFt").value).toBe("3281");
    expect(inputByName("GainFt").value).toBe("1640");
    expect(inputByName("UpMi").value).toBe("0.7");
    expect(inputByName("DnMi").value).toBe("0.7");
    expect(inputByName("UpHr").value).toBe("1");
    expect(inputByName("UpMin").value).toBe("30");
    expect(inputByName("DnHr").value).toBe("1");
    expect(inputByName("DnMin").value).toBe("30");
  });

  it('checks the AscentTypeRBL radio with value="S"', async () => {
    await init();

    const sRadio = document.querySelector<HTMLInputElement>(
      'input[name="AscentTypeRBL"][value="S"]',
    );
    const aRadio = document.querySelector<HTMLInputElement>(
      'input[name="AscentTypeRBL"][value="A"]',
    );
    expect(sRadio?.checked).toBe(true);
    expect(aRadio?.checked).toBe(false);
  });

  it("dispatches input and change events on each filled field", async () => {
    const dateInput = inputByName("DateText");
    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    dateInput.addEventListener("input", inputSpy);
    dateInput.addEventListener("change", changeSpy);

    await init();

    expect(inputSpy).toHaveBeenCalled();
    expect(changeSpy).toHaveBeenCalled();
  });

  it("does NOT send an ascent-saved message on the pre-fill path", async () => {
    await init();

    expect(storage.messages).toEqual([]);
  });
});

describe("init — resilience to missing fields", () => {
  it("is non-fatal when a single form field is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({ omit: new Set(["JournalText"]) });

    await init();

    // The other fields are still filled.
    expect(inputByName("DateText").value).toBe("2026-04-15");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[name="JournalText"]'),
    );
  });

  it("warns when the AscentTypeRBL radio group is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({ omit: new Set(["AscentTypeRBL"]) });

    await init();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("AscentTypeRBL"),
    );
    // Other fields filled as usual.
    expect(inputByName("DateText").value).toBe("2026-04-15");
  });
});

describe("init — post-save state", () => {
  it("sends ascent-saved with the aid when present", async () => {
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}&aid=99&cid=42#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({ withSaved: true });

    await init();

    expect(storage.messages).toEqual([
      { type: "ascent-saved", stravaId: STRAVA_ID, peakId: PEAK_ID, ascentId: 99 },
    ]);
    // Fields should NOT be filled on the save path.
    expect(inputByName("DateText").value).toBe("");
  });

  it("sends ascent-saved with ascentId=null when no aid in URL", async () => {
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({ withSaved: true });

    await init();

    expect(storage.messages).toEqual([
      { type: "ascent-saved", stravaId: STRAVA_ID, peakId: PEAK_ID, ascentId: null },
    ]);
  });
});
