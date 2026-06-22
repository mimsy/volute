/**
 * Classify a raw turn-failure error string into a short reason tag plus a
 * human-readable explanation the mind reads on its next successful turn.
 * Kept in one place so the wording can be improved without touching capture
 * sites or the DB schema.
 */
export type ErrorReason = "auth_error" | "rate_limit" | "overloaded" | "network" | "unknown";

export type Classified = { reason: ErrorReason; detail: string };

export function classify(raw: string): Classified {
  const s = (raw ?? "").toLowerCase();

  if (
    /\b(401|403)\b|authentication_error|invalid authentication|invalid x-api-key|unauthorized|permission_error/.test(
      s,
    )
  ) {
    return {
      reason: "auth_error",
      detail:
        "Your last turn failed because your model credentials were rejected (most often an expired token). The daemon refreshes them automatically, so this is normally transient — you're fine to continue.",
    };
  }

  if (/\b429\b|rate.?limit|too many requests/.test(s)) {
    return {
      reason: "rate_limit",
      detail:
        "Your last turn failed because you hit the model provider's rate limit. This is temporary — it clears on its own shortly.",
    };
  }

  if (/\b529\b|overloaded/.test(s)) {
    return {
      reason: "overloaded",
      detail:
        "Your last turn failed because the model provider was overloaded (a 529). This is transient and resolves on its own.",
    };
  }

  if (
    /econnreset|etimedout|enotfound|econnrefused|fetch failed|network|socket hang up|timeout/.test(
      s,
    )
  ) {
    return {
      reason: "network",
      detail:
        "Your last turn failed due to a network error reaching the model provider. This is transient — the connection should recover.",
    };
  }

  return {
    reason: "unknown",
    detail: `Your last turn failed with an error: ${raw}`,
  };
}
