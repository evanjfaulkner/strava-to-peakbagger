import {
  clearStravaTokens,
  get,
  getStravaCreds,
  setStravaTokens,
} from "./storage";

export const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_SCOPE = "read,activity:read_all";
export const REFRESH_THRESHOLD_SEC = 60;

export type ConnectResult = {
  athleteId: number;
  firstname: string;
  lastname: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: {
    id: number;
    firstname?: string;
    lastname?: string;
  };
};

export async function connectStrava(): Promise<ConnectResult> {
  const { clientId, clientSecret } = await getStravaCreds();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Strava credentials are not configured — fill them in on the Options page first",
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL(STRAVA_AUTHORIZE_URL);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    approval_prompt: "auto",
    scope: STRAVA_SCOPE,
  }).toString();

  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (e) {
    throw new Error(
      `Strava authorization was cancelled: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!redirect) {
    throw new Error("Strava authorization was cancelled");
  }

  const params = new URL(redirect).searchParams;
  const error = params.get("error");
  if (error) {
    throw new Error(`Strava authorization failed: ${error}`);
  }
  const code = params.get("code");
  if (!code) {
    throw new Error("Strava authorization returned no code");
  }

  const tokens = await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
  });

  if (!tokens.athlete?.id) {
    throw new Error("Strava token response missing athlete.id");
  }

  await setStravaTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
    athleteId: tokens.athlete.id,
    athleteFirstname: tokens.athlete.firstname,
    athleteLastname: tokens.athlete.lastname,
  });

  return {
    athleteId: tokens.athlete.id,
    firstname: tokens.athlete.firstname ?? "",
    lastname: tokens.athlete.lastname ?? "",
  };
}

export async function getValidAccessToken(): Promise<string> {
  const strava = await get("strava");
  if (!strava?.accessToken || !strava.refreshToken) {
    throw new Error(
      "Not connected to Strava — click Connect on the Options page",
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (
    typeof strava.expiresAt === "number" &&
    strava.expiresAt - nowSec > REFRESH_THRESHOLD_SEC
  ) {
    return strava.accessToken;
  }

  let refreshed: TokenResponse;
  try {
    refreshed = await postToken({
      client_id: strava.clientId,
      client_secret: strava.clientSecret,
      refresh_token: strava.refreshToken,
      grant_type: "refresh_token",
    });
  } catch (e) {
    if (e instanceof TokenHTTPError && (e.status === 400 || e.status === 401)) {
      await clearStravaTokens();
      throw new Error(
        "Strava refresh token is invalid — please reconnect on the Options page",
      );
    }
    throw e;
  }

  if (strava.athleteId === undefined) {
    throw new Error("Internal: connected slot has no athleteId");
  }

  await setStravaTokens({
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? strava.refreshToken,
    expiresAt: refreshed.expires_at,
    athleteId: strava.athleteId,
    athleteFirstname: strava.athleteFirstname,
    athleteLastname: strava.athleteLastname,
  });

  return refreshed.access_token;
}

export async function isConnected(): Promise<boolean> {
  const strava = await get("strava");
  return Boolean(strava?.accessToken && strava?.refreshToken);
}

class TokenHTTPError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Strava token endpoint returned ${status}: ${body}`);
    this.name = "TokenHTTPError";
  }
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TokenHTTPError(res.status, text);
  }
  return (await res.json()) as TokenResponse;
}
