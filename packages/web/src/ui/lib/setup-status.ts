/** Partial setup state, reported by the daemon while the wizard is unfinished. */
export type SetupProgress = {
  hasSystem?: boolean;
  hasAccount?: boolean;
  setupType?: string | null;
  spiritName?: string | null;
};

/**
 * Outcome of probing `/api/v1/setup/status`.
 *
 * The distinction that matters is `absent` vs `error`. A 404 means the daemon
 * has no setup endpoint at all — it predates the wizard, so its setup is
 * complete by definition. Every other failure (502, DNS, parse error) tells us
 * nothing about setup state, and guessing "complete" there sends a user on a
 * genuinely un-set-up system to a login screen where no account exists (#724).
 */
export type SetupStatus =
  | { kind: "ok"; complete: boolean; progress: SetupProgress | null }
  | { kind: "absent" }
  | { kind: "error"; message: string };

export async function fetchSetupStatus(): Promise<SetupStatus> {
  try {
    const res = await fetch("/api/v1/setup/status");
    if (res.status === 404) return { kind: "absent" };
    if (!res.ok) {
      console.warn(`[setup] status check failed: ${res.status}`);
      return { kind: "error", message: `Setup status check failed (${res.status})` };
    }
    const data = await res.json();
    const complete = !!data.complete;
    return {
      kind: "ok",
      complete,
      progress: complete
        ? null
        : {
            hasSystem: data.hasSystem,
            hasAccount: data.hasAccount,
            setupType: data.setupType,
            spiritName: data.spiritName,
          },
    };
  } catch (err) {
    console.warn("[setup] status check failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `Setup status check failed: ${detail}` };
  }
}
