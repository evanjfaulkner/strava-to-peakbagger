// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/storage";
import { installFakeChromeStorage } from "./fakeChromeStorage";

vi.mock("../lib/oauth", () => ({
  connectStrava: vi.fn(),
  isConnected: vi.fn(),
}));

const { connectStrava, isConnected } = await import("../lib/oauth");
const { init } = await import("../entrypoints/options/main");

// Minimal DOM that matches entrypoints/options/index.html. The test
// is the contract — if the production markup drifts in a way that
// removes/renames an id, the assertions here fail loudly.
const PAGE_HTML = `
  <section id="connection">
    <button id="connect-btn" type="button" disabled>Connect Strava</button>
    <p id="connect-status" role="status"></p>
    <div id="connected-block" hidden>
      <p>Connected as <strong id="athlete-name"></strong>
      (#<span id="athlete-id"></span>)</p>
    </div>
  </section>
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

function button(id: string): HTMLButtonElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`#${id} missing`);
  return node;
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

function statusText(): string {
  return document.getElementById("status")?.textContent ?? "";
}

function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

let storage: ReturnType<typeof installFakeChromeStorage>;

beforeEach(() => {
  storage = installFakeChromeStorage();
  document.body.innerHTML = PAGE_HTML;
  vi.mocked(connectStrava).mockReset();
  vi.mocked(isConnected).mockReset();
  vi.mocked(isConnected).mockResolvedValue(false);
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
    await flushAsync();
    await flushAsync();
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

describe("options page — connect button", () => {
  async function clickConnect(): Promise<void> {
    button("connect-btn").click();
    await flushAsync();
    await flushAsync();
  }

  it("is disabled when creds are empty", async () => {
    await init();
    expect(button("connect-btn").disabled).toBe(true);
  });

  it("enables when creds are typed", async () => {
    await init();

    input("clientId").value = "abc";
    input("clientId").dispatchEvent(new Event("input", { bubbles: true }));
    expect(button("connect-btn").disabled).toBe(true); // still missing secret

    input("clientSecret").value = "shh";
    input("clientSecret").dispatchEvent(new Event("input", { bubbles: true }));
    expect(button("connect-btn").disabled).toBe(false);
  });

  it("renders connected block on successful connect", async () => {
    storage.bag["strava"] = { clientId: "abc", clientSecret: "shh" };
    vi.mocked(connectStrava).mockResolvedValue({
      athleteId: 12345,
      firstname: "Evan",
      lastname: "Faulkner",
    });

    await init();
    await clickConnect();

    expect(document.getElementById("connected-block")?.hasAttribute("hidden"))
      .toBe(false);
    expect(text("athlete-name")).toBe("Evan Faulkner");
    expect(text("athlete-id")).toBe("12345");
    expect(button("connect-btn").textContent).toBe("Reconnect");
    expect(text("connect-status")).toBe("");
  });

  it("surfaces the error on a failed connect", async () => {
    storage.bag["strava"] = { clientId: "abc", clientSecret: "shh" };
    vi.mocked(connectStrava).mockRejectedValue(
      new Error("Strava authorization was cancelled"),
    );

    await init();
    await clickConnect();

    expect(text("connect-status")).toContain("cancelled");
    expect(document.getElementById("connected-block")?.hasAttribute("hidden"))
      .toBe(true);
    expect(button("connect-btn").disabled).toBe(false);
  });

  it("renders connected block on init when already connected", async () => {
    storage.bag["strava"] = {
      clientId: "abc",
      clientSecret: "shh",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 9_999_999_999,
      athleteId: 12345,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    };
    vi.mocked(isConnected).mockResolvedValue(true);

    await init();

    expect(document.getElementById("connected-block")?.hasAttribute("hidden"))
      .toBe(false);
    expect(text("athlete-name")).toBe("Evan Faulkner");
    expect(text("athlete-id")).toBe("12345");
    expect(button("connect-btn").textContent).toBe("Reconnect");
    expect(vi.mocked(connectStrava)).not.toHaveBeenCalled();
  });
});
