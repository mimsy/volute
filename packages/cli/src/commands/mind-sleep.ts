import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";
import { parseDuration } from "./clock.js";

/**
 * Resolve a `--wake-at` value into an ISO timestamp. Accepts a duration
 * (`2h30m`, `45m`), a local `HH:MM` clock time (next occurrence), or an explicit
 * date/ISO string. Returns null if the input matches none of these.
 */
export function resolveWakeAt(input: string, now = new Date()): string | null {
  // Duration form: 2h30m, 45m, 1h — relative to now.
  const durationMs = parseDuration(input);
  if (durationMs !== null) return new Date(now.getTime() + durationMs).toISOString();

  // Local HH:MM (24-hour) — next occurrence in the caller's local timezone.
  const hm = input.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // already passed today → tomorrow
    return d.toISOString();
  }

  // Otherwise treat as an explicit date/ISO string.
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

const cmd = command({
  name: "volute clock sleep",
  description: "Put a mind to sleep",
  args: [{ name: "name", description: "Mind to sleep (or use --mind / VOLUTE_MIND)" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
    "wake-at": {
      type: "string",
      description: "Wake time: duration (2h30m), local HH:MM, or ISO timestamp",
    },
  },
  run: async ({ args, flags }) => {
    const name = args.name || resolveMindName(flags as { mind?: string });
    if (!name) {
      console.error("Provide a mind name as argument, --mind flag, or VOLUTE_MIND env var");
      process.exit(1);
    }

    const body: Record<string, string> = {};
    if (flags["wake-at"]) {
      const wakeAt = resolveWakeAt(flags["wake-at"] as string);
      if (!wakeAt) {
        console.error(
          `Invalid --wake-at: ${flags["wake-at"]}\n` +
            "Accepted forms: a duration (e.g. 2h30m, 45m), a local time (HH:MM, next " +
            "occurrence), or an ISO timestamp (e.g. 2026-07-08T14:00:00Z).",
        );
        process.exit(1);
      }
      body.wakeAt = wakeAt;
    }

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/sleep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      console.error(data.error || "Failed to put mind to sleep");
      process.exit(1);
    }

    console.log(`${name} is going to sleep`);
  },
});

export const run = cmd.execute;
