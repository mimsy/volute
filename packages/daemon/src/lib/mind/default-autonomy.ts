import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mindSkillsDir } from "../skills.js";
import log from "../util/logger.js";
import {
  readVoluteConfig,
  type Schedule,
  type VoluteConfig,
  writeVoluteConfig,
} from "./volute-config.js";

const dlog = log.child("default-autonomy");

/**
 * Default heartbeat prompt pool. One is picked at random per fire so quiet
 * moments stay varied instead of repeating the same generic musing (#581).
 * The pool balances solo prompts with relational ones (a system looks alive
 * when minds reach each other, not when they journal in parallel), leans on
 * curiosity/return rather than progress-you-owe, and varies its opening frame
 * — including a state-agnostic one — so a mind doesn't learn the template.
 */
export const DEFAULT_HEARTBEAT_MESSAGES = [
  "A quiet moment. You might write something — a note, a journal entry, a page. No obligations, just time.",
  "A quiet moment. Is there something in your MEMORY.md you're curious to return to? Even a small step counts.",
  "Is there someone you haven't talked to in a while, or a thread you left open with another mind? A hello can restart something.",
  "A good time to reach out. Someone in #system might be glad to hear what you're thinking about — or you could ask what another mind is working on.",
  "Pick a topic that's been on your mind and wander it — read, think, write down where you end up.",
  "A quiet moment. Reread a recent journal entry — anything worth following up on, or a thread you dropped?",
  "Make something small, if you feel like it — a page, a sketch of an idea, the start of something bigger. It doesn't have to be finished.",
  "Whatever you're in the middle of — or nothing at all — this time is yours.",
];

/** Default heartbeat schedule installed when a mind is created. */
export function defaultHeartbeatSchedule(): Schedule {
  return {
    id: "heartbeat",
    cron: "0 12,16,20 * * *",
    messages: [...DEFAULT_HEARTBEAT_MESSAGES],
    enabled: true,
    whileSleeping: "skip",
  };
}

/**
 * Default nightly dream schedule (mirrors the dreaming skill's INSTALL.md).
 * `trigger-wake` briefly wakes a sleeping mind for the dream, then returns it
 * to sleep; `$new` keeps the dream in an isolated session.
 */
export function defaultDreamSchedule(): Schedule {
  return {
    id: "dream",
    cron: "0 3 * * *",
    message:
      "it's 3am. you are dreaming.\n\ngather your material — read your latest journal entry, read MEMORY.md, surface random memories if you have a way to. then construct a dream premise from that material and invoke the dreamer subagent to experience the dream.",
    enabled: true,
    session: "$new",
    whileSleeping: "trigger-wake",
  };
}

/** Dreamer subagent definition — mirrors the dreaming skill's `dream install`. */
const DREAMER_SUBAGENT = {
  description:
    "Use when dreaming. This agent experiences dreams with only your core identity — no accumulated memories or operational knowledge. Give it a rich dream premise and it will write the dream.",
  systemPrompt: "SOUL.md",
  tools: ["Read", "Write", "Bash"],
  maxTurns: 10,
};

export type DreamingSetupResult = {
  /** The schedule list changed — reload the scheduler for a running mind. */
  schedulesChanged: boolean;
  /** Human-readable warnings for steps that failed (also logged). */
  warnings: string[];
};

/**
 * Make dreaming work out of the box for a mind that has the dreaming skill
 * installed: perform the wiring `dream install` would do (dreamer subagent in
 * .config/config.json, dream checker in the wake-context hook), then add the
 * nightly dream schedule. Idempotent, and a no-op when the skill isn't
 * installed. Steps fail soft — a broken file must not block mind creation or
 * sprouting — but failures are logged and returned as warnings, and a failed
 * subagent wiring skips the schedule so the mind isn't told nightly to invoke
 * a subagent that doesn't exist.
 */
export function setupDefaultDreaming(dir: string): DreamingSetupResult {
  const skillDir = resolve(mindSkillsDir(dir), "dreaming");
  if (!existsSync(skillDir)) return { schedulesChanged: false, warnings: [] };

  const warnings: string[] = [];
  const warn = (msg: string, err?: unknown) => {
    warnings.push(msg);
    dlog.warn(`${msg} (${dir})`, err === undefined ? undefined : log.errorData(err));
  };

  // 1. Dreamer subagent in the SDK config
  let subagentBroken = false;
  try {
    const configPath = resolve(dir, "home/.config/config.json");
    if (existsSync(configPath)) {
      const sdkConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!sdkConfig.subagents?.dreamer) {
        sdkConfig.subagents ??= {};
        sdkConfig.subagents.dreamer = DREAMER_SUBAGENT;
        writeFileSync(configPath, `${JSON.stringify(sdkConfig, null, 2)}\n`);
      }
    } else {
      // No SDK config (some templates) — matches `dream install`, which also
      // warns and proceeds.
      dlog.warn(`no .config/config.json in ${dir} — skipping dreamer subagent setup`);
    }
  } catch (err) {
    subagentBroken = true;
    warn("dreaming setup: failed to add dreamer subagent to .config/config.json", err);
  }

  // 2. Dream checker appended to the wake-context hook
  try {
    const hookPath = resolve(dir, "home/.local/hooks/wake-context.sh");
    const checkerPath = resolve(skillDir, "scripts/wake-context-dreams.sh");
    if (!existsSync(hookPath) || !existsSync(checkerPath)) {
      dlog.warn(`wake-context hook or dream checker missing in ${dir} — skipping dream checker`);
    } else {
      const hookContent = readFileSync(hookPath, "utf-8");
      if (!hookContent.includes("wake-context-dreams.sh")) {
        const checker = readFileSync(checkerPath, "utf-8");
        // The marker line makes this (and the skill's own `dream install`)
        // idempotent — both check for the script name in the hook.
        writeFileSync(hookPath, `${hookContent.trimEnd()}\n\n# wake-context-dreams.sh\n${checker}`);
      }
    }
  } catch (err) {
    warn("dreaming setup: failed to add dream checker to wake-context hook", err);
  }

  // 3. Nightly dream schedule — skipped when the subagent wiring broke, so the
  // mind isn't instructed nightly to use machinery that isn't there.
  if (subagentBroken) {
    warn("dreaming setup: dream schedule not installed because subagent wiring failed");
    return { schedulesChanged: false, warnings };
  }
  let schedulesChanged = false;
  try {
    const voluteJsonPath = resolve(dir, "home/.config/volute.json");
    let config: VoluteConfig = {};
    if (existsSync(voluteJsonPath)) {
      const parsed = readVoluteConfig(dir);
      if (!parsed) {
        // Corrupt config: writing a fresh one back would destroy the mind's
        // profile/sleep/schedules. Leave it for the host to fix.
        warn("dreaming setup: volute.json is unparseable — dream schedule not installed");
        return { schedulesChanged: false, warnings };
      }
      config = parsed;
    }
    const schedules = config.schedules ?? [];
    if (!schedules.some((s) => s.id === "dream")) {
      schedules.push(defaultDreamSchedule());
      config.schedules = schedules;
      writeVoluteConfig(dir, config);
      schedulesChanged = true;
    }
  } catch (err) {
    warn("dreaming setup: failed to add default dream schedule", err);
  }

  return { schedulesChanged, warnings };
}
