import { formatTokens, printableHeading } from "@volute/daemon/lib/mind/memory-size.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind status",
  description: "Check a mind's status",
  args: [{ name: "name", description: "Mind to check (or use VOLUTE_MIND)" }],
  flags: {},
  async run({ args }) {
    const name = args.name || (process.env.VOLUTE_MIND ? resolveMindName({}) : undefined);
    if (!name) {
      console.error("Usage: volute mind status <name>");
      process.exit(1);
    }

    const res = await daemonFetch(`/api/v1/minds/${encodeURIComponent(name)}`);
    if (!res.ok) {
      if (res.status === 404) {
        console.error(`Mind "${name}" not found`);
      } else {
        const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error: string;
        };
        console.error(`Failed to get mind status: ${body.error}`);
      }
      process.exit(1);
    }

    const mind = (await res.json()) as {
      name: string;
      // Withheld from non-admin callers, a mind reading its own status included (#503).
      port?: number;
      status?: string;
      running?: boolean;
      stage?: string;
      parent?: string;
      model?: string;
      memory?: {
        bytes: number;
        chars: number;
        estTokens: number;
        softBudgetTokens: number;
        hardCapTokens: number;
        overBudget: boolean;
        overHardCap: boolean;
      } | null;
      templateStale?: boolean;
      upgradeBlocked?: string;
      channels?: Array<{ name: string; displayName?: string; status: string }>;
      variants?: Array<{ name: string; status: string }>;
      hasPages?: boolean;
      lastNotice?: { kind: string; reason: string; detail: string; created_at: string };
    };

    const status = mind.status ?? (mind.running ? "running" : "stopped");
    console.log(`Mind:    ${mind.name}`);
    console.log(`Status:  ${status}`);
    if (mind.port !== undefined) console.log(`Port:    ${mind.port}`);
    if (mind.stage) console.log(`Stage:   ${mind.stage}`);
    if (mind.parent) console.log(`Parent:  ${mind.parent}`);
    if (mind.model) console.log(`Model:   ${mind.model}`);
    if (mind.memory) {
      let line = `Memory:  ${formatTokens(mind.memory.estTokens)} (${Math.round(mind.memory.bytes / 1024)}KB), always loaded`;
      if (mind.memory.overHardCap) {
        line += ` — exceeds the load cap (${formatTokens(mind.memory.hardCapTokens)}); only the head is loaded`;
      } else if (mind.memory.overBudget) {
        line += ` — over the recommended budget (${formatTokens(mind.memory.softBudgetTokens)}); consider consolidating`;
      }
      console.log(line);
      await printMemoryDetail(name);
    }
    if (mind.templateStale) {
      console.log(`Template: outdated — run 'volute mind upgrade ${mind.name}'`);
    }
    if (mind.upgradeBlocked) {
      console.log(`[upgrade blocked: ${mind.upgradeBlocked}]`);
    }

    // Surface the newest un-drained failure notice so a silent mind explains itself
    // (e.g. missing credentials, a failed turn) without reading the DB or logs. #573
    if (mind.lastNotice) {
      const label = mind.lastNotice.kind === "turn_error" ? "Last turn failed" : "Last issue";
      console.log(`\n${label}: ${mind.lastNotice.detail}`);
    }

    if (mind.channels && mind.channels.length > 0) {
      console.log(`\nChannels:`);
      for (const ch of mind.channels) {
        console.log(`  ${ch.displayName ?? ch.name}: ${ch.status}`);
      }
    }

    if (mind.variants && mind.variants.length > 0) {
      console.log(`\nVariants:`);
      for (const v of mind.variants) {
        console.log(`  ${v.name}: ${v.status}`);
      }
    }

    if (mind.hasPages) console.log(`\nPages:   published`);

    // Surface unrouted (gated) channels holding messages, so a months-long silence
    // is visible without reading the DB. #537
    const pendingRes = await daemonFetch(
      `/api/v1/minds/${encodeURIComponent(name)}/delivery/pending`,
    ).catch(() => null);
    if (pendingRes?.ok) {
      const pending = (await pendingRes.json().catch(() => [])) as Array<{
        channel: string | null;
        count: number;
      }>;
      if (pending.length > 0) {
        const total = pending.reduce((sum, p) => sum + p.count, 0);
        console.log(`\nGated channels (held, unrouted): ${total} message(s)`);
        for (const p of pending) {
          console.log(`  ${p.channel ?? "unknown"}: ${p.count}`);
        }
      }
    }
  },
});

/**
 * Headroom and the per-section table (#954), so a mind can reason about its core
 * in the characters it actually writes. Served only to the mind itself and admins
 * (section headings are the mind's own words); anyone else just doesn't see it.
 */
async function printMemoryDetail(name: string): Promise<void> {
  const res = await daemonFetch(`/api/v1/minds/${encodeURIComponent(name)}/memory`).catch(
    () => null,
  );
  if (!res?.ok) return;
  const detail = (await res.json().catch(() => null)) as {
    chars: number;
    softBudgetTokens: number;
    hardCapTokens: number;
    sections: Array<{ heading: string | null; chars: number; estTokens: number }> | null;
  } | null;
  if (!detail) return;

  const n = (x: number) => x.toLocaleString("en-US");
  const room = (budgetTokens: number, label: string) => {
    const left = budgetTokens * 4 - detail.chars;
    return left >= 0
      ? `${n(left)} chars (${formatTokens(Math.round(left / 4))}) left before the ${label}`
      : `${n(-left)} chars (${formatTokens(Math.round(-left / 4))}) over the ${label}`;
  };
  console.log(`         ${room(detail.softBudgetTokens, "recommended budget")}`);
  console.log(`         ${room(detail.hardCapTokens, "load cap")}`);
  console.log("         (tokens are estimated as chars/4, which undercounts dense prose)");

  if (detail.sections && detail.sections.length > 1) {
    console.log(`\nMemory sections:`);
    const headings = detail.sections.map((s) =>
      s.heading === null ? "(before first heading)" : printableHeading(s.heading),
    );
    const width = Math.min(48, Math.max(...headings.map((h) => h.length)));
    for (const [i, s] of detail.sections.entries()) {
      const heading = headings[i];
      const label = heading.length > width ? `${heading.slice(0, width - 1)}…` : heading;
      console.log(
        `  ${label.padEnd(width)}  ${formatTokens(s.estTokens).padStart(14)}  ${n(s.chars)} chars`,
      );
    }
  }
}

export const run = cmd.execute;
