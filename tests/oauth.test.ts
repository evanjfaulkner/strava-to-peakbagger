import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  STRAVA_TOKEN_URL,
  connectStrava,
  getValidAccessToken,
  isConnected,
} from "../lib/oauth";
import { installFakeChromeStorage } from "./fakeChromeStorage";

let storage: ReturnType<typeof installFakeChromeStorage>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

const FAKE_TOKEN_RESPONSE = {
  token_type: "Bearer",
  access_token: "AT-new",
  refresh_token: "RT-new",
  expires_at: 9_999_999_999,
  expires_in: 21600,
  athlete: {
    id: 12345,
    firstname: "Evan",
    lastname: "Faulkner",
    username: "evanf",
  },
};

beforeEach(() => {
  storage = installFakeChromeStorage();
  storage.bag["strava"] = { clientId: "cid", clientSecret: "secret" };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectStrava", () => {
  it("happy path: exchanges code and writes tokens + athlete", async () => {
    storage.identity.launchWebAuthFlow = vi
      .fn()
      .mockResolvedValue(
        "https://test-extension.chromiumapp.org/?code=AUTHCODE&scope=read,activity:read_all",
      );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FAKE_TOKEN_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectStrava();

    expect(result).toEqual({
      athleteId: 12345,
      firstname: "Evan",
      lastname: "Faulkner",
    });
    expect(storage.bag["strava"]).toEqual({
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-new",
      refreshToken: "RT-new",
      expiresAt: 9_999_999_999,
      athleteId: 12345,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(STRAVA_TOKEN_URL);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      client_id: "cid",
      client_secret: "secret",
      code: "AUTHCODE",
      grant_type: "authorization_code",
    });
  });

  it("throws when creds are missing", async () => {
    storage.bag["strava"] = { clientId: "", clientSecret: "" };

    await expect(connectStrava()).rejects.toThrow(/Options page/);
  });

  it("throws when launchWebAuthFlow rejects (user cancelled)", async () => {
    storage.identity.launchWebAuthFlow = vi
      .fn()
      .mockRejectedValue(new Error("user closed window"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectStrava()).rejects.toThrow(/cancelled/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.bag["strava"]).toEqual({
      clientId: "cid",
      clientSecret: "secret",
    });
  });

  it("throws when redirect URL contains ?error=", async () => {
    storage.identity.launchWebAuthFlow = vi
      .fn()
      .mockResolvedValue(
        "https://test-extension.chromiumapp.org/?error=access_denied",
      );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectStrava()).rejects.toThrow(/access_denied/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws and includes body when token exchange returns non-OK", async () => {
    storage.identity.launchWebAuthFlow = vi
      .fn()
      .mockResolvedValue(
        "https://test-extension.chromiumapp.org/?code=AUTHCODE",
      );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse("Bad Request: invalid code", 400)),
    );

    await expect(connectStrava()).rejects.toThrow(/invalid code|400/);
    // tokens were NOT written
    expect(storage.bag["strava"]).toEqual({
      clientId: "cid",
      clientSecret: "secret",
    });
  });
});

describe("getValidAccessToken", () => {
  it("returns cached token when not near expiry", async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-cached",
      refreshToken: "RT-cached",
      expiresAt: farFuture,
      athleteId: 1,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await getValidAccessToken()).toBe("AT-cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when expires_at is within the threshold", async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 30; // < REFRESH_THRESHOLD_SEC
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-old",
      refreshToken: "RT-old",
      expiresAt: nearExpiry,
      athleteId: 7,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    };

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "AT-refreshed",
        refresh_token: "RT-rotated",
        expires_at: nearExpiry + 21600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getValidAccessToken()).toBe("AT-refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "RT-old",
      client_id: "cid",
      client_secret: "secret",
    });

    expect(storage.bag["strava"]).toEqual({
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-refreshed",
      refreshToken: "RT-rotated",
      expiresAt: nearExpiry + 21600,
      athleteId: 7,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    });
  });

  it("keeps the old refresh_token when the refresh response omits it", async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 30;
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-old",
      refreshToken: "RT-keep",
      expiresAt: nearExpiry,
      athleteId: 1,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: "AT-refreshed",
          expires_at: nearExpiry + 21600,
        }),
      ),
    );

    await getValidAccessToken();
    const strava = storage.bag["strava"] as { refreshToken: string };
    expect(strava.refreshToken).toBe("RT-keep");
  });

  it("clears tokens and throws on 401 refresh", async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 10;
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-old",
      refreshToken: "RT-bad",
      expiresAt: nearExpiry,
      athleteId: 1,
      athleteFirstname: "Evan",
      athleteLastname: "Faulkner",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse("Bad refresh token", 401)),
    );

    await expect(getValidAccessToken()).rejects.toThrow(/reconnect/);

    expect(storage.bag["strava"]).toEqual({
      clientId: "cid",
      clientSecret: "secret",
    });
  });

  it("does NOT clear tokens on transient 5xx refresh", async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 10;
    const initial = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT-old",
      refreshToken: "RT-keep",
      expiresAt: nearExpiry,
      athleteId: 1,
    };
    storage.bag["strava"] = { ...initial };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse("Upstream timeout", 503)),
    );

    await expect(getValidAccessToken()).rejects.toThrow();
    expect(storage.bag["strava"]).toEqual(initial);
  });

  it("throws Not connected when tokens are missing", async () => {
    storage.bag["strava"] = { clientId: "cid", clientSecret: "secret" };

    await expect(getValidAccessToken()).rejects.toThrow(/Not connected/);
  });
});

describe("isConnected", () => {
  it("returns false on empty storage", async () => {
    storage.bag["strava"] = { clientId: "cid", clientSecret: "secret" };
    expect(await isConnected()).toBe(false);
  });

  it("returns true when both tokens are present", async () => {
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT",
      refreshToken: "RT",
    };
    expect(await isConnected()).toBe(true);
  });

  it("returns false when only access token is present", async () => {
    storage.bag["strava"] = {
      clientId: "cid",
      clientSecret: "secret",
      accessToken: "AT",
    };
    expect(await isConnected()).toBe(false);
  });
});
