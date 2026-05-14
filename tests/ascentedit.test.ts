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
let currentMaxTripId: (s: HTMLSelectElement) => number;
let pickLatestTripIdAfter: (s: HTMLSelectElement, prior: number) => number | null;

beforeAll(async () => {
  const mod = await import("../entrypoints/ascentedit.content");
  init = mod.init;
  currentMaxTripId = mod.currentMaxTripId;
  pickLatestTripIdAfter = mod.pickLatestTripIdAfter;
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
  tripChoice: { kind: "single" },
};

function setUrl(href: string): void {
  Object.defineProperty(window, "location", {
    value: new URL(href),
    writable: true,
    configurable: true,
  });
}

function buildPeakbaggerForm(
  opts: {
    withSaved?: boolean;
    omit?: Set<string>;
    tripDDOptions?: Array<{ value: string; label?: string }>;
  } = {},
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
    "TripNameText",
    "TripNightsText",
    "TripSeqText",
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
  if (!omit.has("TripDD")) {
    const tripOptions = opts.tripDDOptions ?? [
      { value: "0", label: "Single Ascent Trip" },
      { value: "-1", label: "Add New Trip" },
      { value: "-2", label: "Update Trip Name/Nights" },
      { value: "200", label: "Existing B" },
      { value: "100", label: "Existing A" },
    ];
    const optionHtml = tripOptions
      .map((o) => `<option value="${o.value}">${o.label ?? ""}</option>`)
      .join("");
    inputs.push(`<select name="TripDD">${optionHtml}</select>`);
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

  it("accepts a negative peakId (peakbagger uses these for some peaks)", async () => {
    const NEG_PEAK_ID = -200643;
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${NEG_PEAK_ID}`]: { ...SAMPLE_PAYLOAD, pid: NEG_PEAK_ID },
    };
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${NEG_PEAK_ID}&cid=42#s2p=${STRAVA_ID}`,
    );

    await init();

    expect(inputByName("DateText").value).toBe("2026-04-15");
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

describe("init — SW tab-mapping fallback (post-save hash stripping)", () => {
  it("uses chrome.runtime.sendMessage to resolve stravaId when hash is gone", async () => {
    // Override sendMessage to return the mapping the SW would.
    const sendMessage = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        mapping: { stravaId: STRAVA_ID, peakId: PEAK_ID },
      });
    (globalThis as unknown as {
      chrome: { runtime: { sendMessage: typeof sendMessage } };
    }).chrome.runtime.sendMessage = sendMessage;

    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}&cid=42`,
    );
    buildPeakbaggerForm();

    await init();

    expect(sendMessage).toHaveBeenCalledWith({ type: "getTabMapping" });
    expect(inputByName("DateText").value).toBe("2026-04-15");
  });

  it("no-ops when SW returns no mapping", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, mapping: null });
    (globalThis as unknown as {
      chrome: { runtime: { sendMessage: typeof sendMessage } };
    }).chrome.runtime.sendMessage = sendMessage;

    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}&cid=42`,
    );
    buildPeakbaggerForm();

    await init();

    expect(inputByName("DateText").value).toBe("");
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

describe("currentMaxTripId / pickLatestTripIdAfter", () => {
  function makeSelect(values: string[]): HTMLSelectElement {
    const s = document.createElement("select");
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      s.appendChild(o);
    }
    return s;
  }

  it("currentMaxTripId returns 0 when only sentinels are present", () => {
    const s = makeSelect(["0", "-1", "-2"]);
    expect(currentMaxTripId(s)).toBe(0);
  });

  it("currentMaxTripId picks the largest positive value", () => {
    const s = makeSelect(["0", "-1", "100", "200", "50"]);
    expect(currentMaxTripId(s)).toBe(200);
  });

  it("pickLatestTripIdAfter returns null when no value > prior", () => {
    const s = makeSelect(["0", "-1", "100", "200"]);
    expect(pickLatestTripIdAfter(s, 200)).toBeNull();
  });

  it("pickLatestTripIdAfter picks the largest value > prior", () => {
    const s = makeSelect(["0", "-1", "100", "200", "300"]);
    expect(pickLatestTripIdAfter(s, 100)).toBe(300);
  });
});

describe("init — trip handling (v0.3)", () => {
  function makePayload(choice: PrefillPayload["tripChoice"]): PrefillPayload {
    return { ...SAMPLE_PAYLOAD, tripChoice: choice };
  }

  function tripDD(): HTMLSelectElement {
    return document.querySelector(
      'select[name="TripDD"]',
    ) as HTMLSelectElement;
  }
  function nameInput(): HTMLInputElement {
    return document.querySelector(
      'input[name="TripNameText"]',
    ) as HTMLInputElement;
  }
  function nightsInput(): HTMLInputElement {
    return document.querySelector(
      'input[name="TripNightsText"]',
    ) as HTMLInputElement;
  }
  function seqInput(): HTMLInputElement {
    return document.querySelector(
      'input[name="TripSeqText"]',
    ) as HTMLInputElement;
  }

  it("kind=single sets TripDD to 0 and leaves the trip text fields empty", async () => {
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${PEAK_ID}`]: makePayload({ kind: "single" }),
    };
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm();

    await init();

    expect(tripDD().value).toBe("0");
    expect(nameInput().value).toBe("");
    expect(seqInput().value).toBe("");
  });

  it("kind=new sends trip-baseline, sets TripDD=-1, fills name/nights/seq", async () => {
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${PEAK_ID}`]: makePayload({
        kind: "new",
        name: "Sierra Traverse",
        nights: 0,
        seq: 1,
      }),
    };
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm(); // default options include max=200

    await init();

    expect(tripDD().value).toBe("-1");
    expect(nameInput().value).toBe("Sierra Traverse");
    expect(nightsInput().value).toBe("0");
    expect(seqInput().value).toBe("1");
    const baseline = storage.messages.find(
      (m): m is { type: string; priorMaxTripId: number } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "trip-baseline",
    );
    expect(baseline).toBeDefined();
    expect(baseline!.priorMaxTripId).toBe(200);
  });

  it("kind=attach-latest picks max trip > priorMaxTripId, fills seq", async () => {
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${PEAK_ID}`]: makePayload({
        kind: "attach-latest",
        seq: 2,
      }),
    };
    storage.bag["activityMatches"] = {
      [STRAVA_ID]: {
        peakIds: [PEAK_ID, 99],
        computedAt: 0,
        priorMaxTripId: 200,
      },
    };
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({
      tripDDOptions: [
        { value: "0" },
        { value: "-1" },
        { value: "-2" },
        { value: "100" },
        { value: "200" },
        { value: "201" }, // the just-created trip
      ],
    });

    await init();

    expect(tripDD().value).toBe("201");
    expect(seqInput().value).toBe("2");
  });

  it("kind=attach-latest with no priorMaxTripId in storage uses 0 (picks overall max)", async () => {
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${PEAK_ID}`]: makePayload({
        kind: "attach-latest",
        seq: 2,
      }),
    };
    // No activityMatches entry seeded → defaults to prior = 0
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({
      tripDDOptions: [
        { value: "0" },
        { value: "-1" },
        { value: "100" },
        { value: "200" },
      ],
    });

    await init();

    expect(tripDD().value).toBe("200");
  });

  it("missing TripDD select is non-fatal (warn + continue filling other fields)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storage.bag["prefillPayloads"] = {
      [`${STRAVA_ID}:${PEAK_ID}`]: makePayload({ kind: "single" }),
    };
    setUrl(
      `https://www.peakbagger.com/climber/ascentedit.aspx?pid=${PEAK_ID}#s2p=${STRAVA_ID}`,
    );
    buildPeakbaggerForm({ omit: new Set(["TripDD"]) });

    await init();

    // Other fields still filled (sample assertion).
    expect(inputByName("DateText").value).toBe("2026-04-15");
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("TripDD select not found"),
      ),
    ).toBe(true);
  });
});
