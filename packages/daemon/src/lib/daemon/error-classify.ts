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
    /\b(401|403)\b|authentication_error|invalid authentication|invalid x-api-key|invalid api key|missing api key|no api key|x-api-key header|could not resolve authentication|unauthorized|permission_error|please run \/login/.test(
      s,
    )
  ) {
    return {
      reason: "auth_error",
      detail:
        "Your last turn failed because the model provider rejected your credentials. A one-off is usually a briefly-expired token that the daemon refreshes automatically. If it keeps happening, your API key is likely missing or invalid — an operator needs to set a valid key (e.g. `volute env set ANTHROPIC_API_KEY <key>`) or reconnect the provider in the dashboard.",
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
