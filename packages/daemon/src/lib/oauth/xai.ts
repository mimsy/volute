/**
 * xAI (Grok) OAuth provider — lets a SuperGrok / X Premium subscriber log in
 * and use their subscription programmatically (no metered API key). Registered
 * into pi-ai's OAuth registry so it flows through Volute's existing provider
 * OAuth UI with no new frontend.
 *
 * We reuse the first-party Grok CLI OAuth client, as every third-party tool in
 * the ecosystem does (OpenClaw, Hermes, and xAI's own blessed OpenCode
 * integration) — xAI offers no bring-your-own-client registration, and its auth
 * server rejects this client from non-allowlisted flows. The consent screen may
 * read "Grok Build" because of the shared client. We prefer the device-code
 * flow: the Volute daemon often runs headless/remote, where a loopback callback
 * can't reach the admin's browser but a "visit URL, enter code" flow can.
 */

import {
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
  pollOAuthDeviceCodeFlow,
  registerOAuthProvider,
} from "@earendil-works/pi-ai/oauth";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_ISSUER = "https://auth.x.ai";
const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`;
// Fallbacks if discovery is unavailable (these are xAI's documented endpoints).
const FALLBACK_DEVICE_ENDPOINT = `${XAI_ISSUER}/oauth2/device/code`;
const FALLBACK_TOKEN_ENDPOINT = `${XAI_ISSUER}/oauth2/token`;

type Endpoints = { deviceEndpoint: string; tokenEndpoint: string };

/** Only accept endpoints served by xAI's auth host — never a redirected origin. */
function validateXaiUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname !== "auth.x.ai" || u.protocol !== "https:") {
    throw new Error(`Refusing non-xAI OAuth endpoint: ${url}`);
  }
  return u.toString();
}

async function discoverEndpoints(signal?: AbortSignal): Promise<Endpoints> {
  try {
    const res = await fetch(XAI_DISCOVERY_URL, { signal });
    if (res.ok) {
      const doc = (await res.json()) as {
        device_authorization_endpoint?: string;
        token_endpoint?: string;
      };
      if (doc.device_authorization_endpoint && doc.token_endpoint) {
        return {
          deviceEndpoint: validateXaiUrl(doc.device_authorization_endpoint),
          tokenEndpoint: validateXaiUrl(doc.token_endpoint),
        };
      }
    }
  } catch {
    // fall through to documented defaults
  }
  return { deviceEndpoint: FALLBACK_DEVICE_ENDPOINT, tokenEndpoint: FALLBACK_TOKEN_ENDPOINT };
}

function credentialsFromTokenResponse(raw: unknown): OAuthCredentials {
  const json = (raw ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("xAI token response missing access_token/expires_in");
  }
  return {
    access: json.access_token,
    // A refresh grant may omit refresh_token; the caller merges the old one.
    refresh: json.refresh_token ?? "",
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { deviceEndpoint, tokenEndpoint } = await discoverEndpoints(callbacks.signal);

  const deviceRes = await fetch(deviceEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
    signal: callbacks.signal,
  });
  if (!deviceRes.ok) {
    throw new Error(`xAI device authorization failed: HTTP ${deviceRes.status}`);
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  callbacks.onDeviceCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri_complete ?? device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });

  return pollOAuthDeviceCodeFlow<OAuthCredentials>({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    signal: callbacks.signal,
    poll: async () => {
      const res = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: XAI_OAUTH_CLIENT_ID,
        }),
        signal: callbacks.signal,
      });
      if (res.ok) {
        return { status: "complete", value: credentialsFromTokenResponse(await res.json()) };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === "authorization_pending") return { status: "pending" };
      if (body.error === "slow_down") return { status: "slow_down" };
      return { status: "failed", message: body.error ?? `HTTP ${res.status}` };
    },
  });
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const { tokenEndpoint } = await discoverEndpoints();
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: XAI_OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`xAI token refresh failed: HTTP ${res.status}`);
  const next = credentialsFromTokenResponse(await res.json());
  // xAI may not re-issue a refresh token; keep the existing one.
  if (!next.refresh) next.refresh = credentials.refresh;
  return next;
}

export const xaiOAuthProvider: OAuthProviderInterface = {
  id: "xai",
  name: "xAI (Grok)",
  usesCallbackServer: false,
  login,
  refreshToken,
  getApiKey: (credentials) => credentials.access,
};

let registered = false;

/** Register the xAI OAuth provider into pi-ai's registry (idempotent). */
export function registerXaiOAuthProvider(): void {
  if (registered) return;
  registerOAuthProvider(xaiOAuthProvider);
  registered = true;
}
