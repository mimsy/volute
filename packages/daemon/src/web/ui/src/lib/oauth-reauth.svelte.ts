/**
 * Shared OAuth re-authentication flow.
 * Used by both the AiProviders settings page and the sidebar warning indicator.
 */
import {
  type AiProvider,
  fetchAiProviders,
  pollAiOAuthStatus,
  startAiOAuth,
  submitAiOAuthCode,
} from "./client";
import { data } from "./stores.svelte";

function initialReauthState() {
  return {
    active: false,
    provider: "",
    providerName: "",
    url: "",
    flowId: "",
    polling: false,
    needsCode: false,
    waitingForCode: false,
    codeInput: "",
    codeSubmitting: false,
    error: "",
    success: false,
  };
}

export const oauthReauth = $state(initialReauthState());

export async function startReauth(providerId: string, providerName?: string) {
  oauthReauth.active = true;
  oauthReauth.provider = providerId;
  oauthReauth.providerName = providerName || providerId;
  oauthReauth.error = "";
  oauthReauth.success = false;

  try {
    const result = await startAiOAuth(providerId);
    if (result.url) {
      oauthReauth.url = result.url;
      oauthReauth.flowId = result.flowId;
      oauthReauth.needsCode = !!result.needsManualCode;
      oauthReauth.polling = true;
      window.open(result.url, "_blank");
      pollReauth();
    }
  } catch (err) {
    oauthReauth.error = err instanceof Error ? err.message : "OAuth failed";
  }
}

async function pollReauth() {
  let errors = 0;
  while (oauthReauth.polling) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const status = await pollAiOAuthStatus(oauthReauth.flowId);
      errors = 0;
      if (status.waitingForCode) {
        oauthReauth.waitingForCode = true;
      }
      if (status.status === "complete") {
        oauthReauth.polling = false;
        oauthReauth.success = true;
        // Refresh provider health
        refreshOauthErrors();
        return;
      } else if (status.status === "error") {
        oauthReauth.polling = false;
        oauthReauth.error = status.error ?? "OAuth failed";
        return;
      }
    } catch {
      errors++;
      if (errors >= 5) {
        oauthReauth.polling = false;
        oauthReauth.error = "Lost connection while waiting for OAuth";
        return;
      }
    }
  }
}

export async function submitCode() {
  if (!oauthReauth.codeInput.trim() || !oauthReauth.flowId) return;
  oauthReauth.error = "";
  oauthReauth.codeSubmitting = true;
  try {
    await submitAiOAuthCode(oauthReauth.flowId, oauthReauth.codeInput.trim());
    oauthReauth.codeInput = "";
  } catch (err) {
    oauthReauth.error = err instanceof Error ? err.message : "Failed to submit code";
  }
  oauthReauth.codeSubmitting = false;
}

export function cancelReauth() {
  oauthReauth.polling = false;
  resetReauth();
}

export function resetReauth() {
  Object.assign(oauthReauth, initialReauthState());
}

export function updateOauthErrors(providers: AiProvider[]) {
  const errors = providers.filter((p) => p.oauthHealthy === false);
  // Skip update if the set of unhealthy providers hasn't changed
  const prev = data.oauthErrors.map((p) => p.id).join(",");
  const next = errors.map((p) => p.id).join(",");
  if (prev !== next) data.oauthErrors = errors;
}

async function refreshOauthErrors() {
  try {
    const providers = await fetchAiProviders();
    updateOauthErrors(providers);
  } catch {
    // Non-critical
  }
}
