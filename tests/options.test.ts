// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/storage";
import { init } from "../entrypoints/options/main";
import { installFakeChromeStorage } from "./fakeChromeStorage";

// Minimal DOM that matches entrypoints/options/index.html. The test
// is the contract — if the production markup drifts in a way that
// removes/renames an id, the assertions here fail loudly.
const FORM_HTML = `
  <form id="options-form" novalidate>
    <input id="clientId" name="clientId" type="text" />
    <input id="clientSecret" name="clientSecret" type="password" />
    <input id="horizM" name="horizM" type="number" min="1" max="500" />
    <input id="vertM" name="vertM" type="number" min="1" max="500" />
    <input id="lookbackDays" name="lookbackDays" type="number" min="1" max="3650" />
    <textarea id="blacklist" name="blacklist"></textarea>
    <button type="submit">Save</button>
    <p id="status" role="status"></p>
  </form>
`;

function input(id: string): HTMLInputElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`#${id} missing`);
  return node;
}

function textarea(id: string): HTMLTextAreaElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLTextAreaElement)) throw new Error(`#${id} missing`);
  return node;
}

function statusText(): string {
  return document.getElementById("status")?.textContent ?? "";
}

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(() => {
  storage = installFakeChromeStorage();
  document.body.innerHTML = FORM_HTML;
});

describe("options page — init", () => {
  it("populates form with defaults when nothing is stored", async () => {
    await init();

    expect(input("clientId").value).toBe("");
    expect(input("clientSecret").value).toBe("");
    expect(input("horizM").value).toBe(String(DEFAULT_SETTINGS.horizM));
    expect(input("vertM").value).toBe(String(DEFAULT_SETTINGS.vertM));
    expect(input("lookbackDays").value).toBe(
      String(DEFAULT_SETTINGS.lookbackDays),
    );
    expect(textarea("blacklist").value).toBe(
      DEFAULT_SETTINGS.blacklist.join("\n"),
    );
  });

  it("pre-fills the form from stored values", async () => {
    storage.bag["strava"] = { clientId: "abc", clientSecret: "shh" };
    storage.bag["settings"] = {
      horizM: 42,
      vertM: 11,
      lookbackDays: 7,
      blacklist: ["Yoga", "Workout"],
    };

    await init();

    expect(input("clientId").value).toBe("abc");
    expect(input("clientSecret").value).toBe("shh");
    expect(input("horizM").value).toBe("42");
    expect(input("vertM").value).toBe("11");
    expect(input("lookbackDays").value).toBe("7");
    expect(textarea("blacklist").value).toBe("Yoga\nWorkout");
  });
});

describe("options page — submit", () => {
  async function submitForm(): Promise<void> {
    const form = document.getElementById("options-form") as HTMLFormElement;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    // Let the async submit handler finish writing storage.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("persists settings and creds", async () => {
    await init();

    input("clientId").value = "id-1";
    input("clientSecret").value = "secret-1";
    input("horizM").value = "33";
    input("vertM").value = "22";
    input("lookbackDays").value = "60";
    textarea("blacklist").value = "Yoga\nWorkout";

    await submitForm();

    expect(storage.bag["strava"]).toEqual({
      clientId: "id-1",
      clientSecret: "secret-1",
    });
    expect(storage.bag["settings"]).toEqual({
      horizM: 33,
      vertM: 22,
      lookbackDays: 60,
      blacklist: ["Yoga", "Workout"],
    });
    expect(statusText()).toMatch(/^Saved \d{2}:\d{2}:\d{2}$/);
  });

  it("preserves existing OAuth fields when editing creds", async () => {
    storage.bag["strava"] = {
      clientId: "old-id",
      clientSecret: "old-secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 999,
      athleteId: 42,
    };

    await init();

    input("clientId").value = "new-id";
    input("clientSecret").value = "new-secret";

    await submitForm();

    expect(storage.bag["strava"]).toEqual({
      clientId: "new-id",
      clientSecret: "new-secret",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 999,
      athleteId: 42,
    });
  });

  it("rejects out-of-range horizM and does not write", async () => {
    await init();

    input("horizM").value = "0";

    await submitForm();

    expect(storage.bag["settings"]).toBeUndefined();
    expect(statusText()).toMatch(/Invalid: horizM/);
  });

  it("trims and filters blacklist lines", async () => {
    await init();

    textarea("blacklist").value = "  Yoga  \n\n  Workout\nSwim\n";

    await submitForm();

    const settings = storage.bag["settings"] as { blacklist: string[] };
    expect(settings.blacklist).toEqual(["Yoga", "Workout", "Swim"]);
  });
});
