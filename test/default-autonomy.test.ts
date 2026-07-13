import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_HEARTBEAT_MESSAGES,
  defaultDreamSchedule,
  defaultHeartbeatSchedule,
  setupDefaultDreaming,
} from "../packages/daemon/src/lib/mind/default-autonomy.js";
import {
  readVoluteConfig,
  writeVoluteConfig,
} from "../packages/daemon/src/lib/mind/volute-config.js";

const CHECKER = "# wake-context-dreams marker\necho dreams\n";

const createdDirs: string[] = [];

function makeMindDir(opts: { skill?: boolean; sdkConfig?: boolean; hook?: boolean } = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), "volute-autonomy-"));
  createdDirs.push(dir);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeVoluteConfig(dir, { schedules: [defaultHeartbeatSchedule()] });
  if (opts.sdkConfig !== false) {
    writeFileSync(resolve(dir, "home/.config/config.json"), "{}\n");
  }
  if (opts.hook !== false) {
    mkdirSync(resolve(dir, "home/.local/hooks"), { recursive: true });
    writeFileSync(resolve(dir, "home/.local/hooks/wake-context.sh"), "#!/bin/bash\necho base\n");
  }
  if (opts.skill !== false) {
    mkdirSync(resolve(dir, "home/.claude/skills/dreaming/scripts"), { recursive: true });
    writeFileSync(
      resolve(dir, "home/.claude/skills/dreaming/scripts/wake-context-dreams.sh"),
      CHECKER,
    );
  }
  return dir;
}

describe("default autonomy", () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default heartbeat schedule rotates through a varied prompt pool", () => {
    const schedule = defaultHeartbeatSchedule();
    assert.equal(schedule.id, "heartbeat");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.whileSleeping, "skip");
    assert.ok(schedule.cron);
    assert.ok((schedule.messages?.length ?? 0) > 1);
    assert.deepEqual(schedule.messages, DEFAULT_HEARTBEAT_MESSAGES);
    // A copy, not the module constant — mutating one mind's config must not
    // corrupt the shared default
    assert.notEqual(schedule.messages, DEFAULT_HEARTBEAT_MESSAGES);
    assert.equal(schedule.message, undefined);
  });

  it("setupDefaultDreaming installs schedule, subagent, and wake hook", () => {
    const dir = makeMindDir();

    const result = setupDefaultDreaming(dir);
    assert.equal(result.schedulesChanged, true);
    assert.deepEqual(result.warnings, []);

    // Dream schedule added alongside the heartbeat
    const config = readVoluteConfig(dir);
    const dream = config?.schedules?.find((s) => s.id === "dream");
    assert.ok(dream, "dream schedule installed");
    assert.equal(dream.cron, "0 3 * * *");
    assert.equal(dream.thread, "$new");
    assert.equal(dream.whileSleeping, "trigger-wake");
    assert.equal(dream.enabled, true);
    assert.ok(config?.schedules?.some((s) => s.id === "heartbeat"));

    // Dreamer subagent wired into the SDK config
    const sdkConfig = JSON.parse(readFileSync(resolve(dir, "home/.config/config.json"), "utf-8"));
    assert.equal(sdkConfig.subagents.dreamer.systemPrompt, "SOUL.md");

    // Dream checker appended to the wake-context hook (base content preserved)
    const hook = readFileSync(resolve(dir, "home/.local/hooks/wake-context.sh"), "utf-8");
    assert.ok(hook.includes("echo base"));
    assert.ok(hook.includes("wake-context-dreams marker"));
  });

  it("setupDefaultDreaming is idempotent", () => {
    const dir = makeMindDir();
    assert.equal(setupDefaultDreaming(dir).schedulesChanged, true);
    assert.equal(setupDefaultDreaming(dir).schedulesChanged, false);

    const config = readVoluteConfig(dir);
    assert.equal(config?.schedules?.filter((s) => s.id === "dream").length, 1);

    const hook = readFileSync(resolve(dir, "home/.local/hooks/wake-context.sh"), "utf-8");
    const occurrences = hook.split("wake-context-dreams marker").length - 1;
    assert.equal(occurrences, 1);
  });

  it("setupDefaultDreaming is a no-op without the dreaming skill", () => {
    const dir = makeMindDir({ skill: false });
    assert.equal(setupDefaultDreaming(dir).schedulesChanged, false);

    const config = readVoluteConfig(dir);
    assert.ok(!config?.schedules?.some((s) => s.id === "dream"));
    const sdkConfig = JSON.parse(readFileSync(resolve(dir, "home/.config/config.json"), "utf-8"));
    assert.equal(sdkConfig.subagents, undefined);
  });

  it("setupDefaultDreaming preserves an existing dream schedule but still wires the rest", () => {
    const dir = makeMindDir();
    const custom = { ...defaultDreamSchedule(), cron: "0 4 * * *" };
    writeVoluteConfig(dir, { schedules: [custom] });

    const result = setupDefaultDreaming(dir);
    assert.equal(result.schedulesChanged, false);

    const config = readVoluteConfig(dir);
    assert.equal(config?.schedules?.length, 1);
    assert.equal(config?.schedules?.[0].cron, "0 4 * * *");

    const sdkConfig = JSON.parse(readFileSync(resolve(dir, "home/.config/config.json"), "utf-8"));
    assert.ok(sdkConfig.subagents?.dreamer);
  });

  it("setupDefaultDreaming leaves a corrupt volute.json untouched", () => {
    const dir = makeMindDir();
    const voluteJsonPath = resolve(dir, "home/.config/volute.json");
    writeFileSync(voluteJsonPath, "{ not json");

    const result = setupDefaultDreaming(dir);
    assert.equal(result.schedulesChanged, false);
    assert.ok(result.warnings.some((w) => w.includes("unparseable")));
    // The corrupt file must not be overwritten with a fresh config
    assert.equal(readFileSync(voluteJsonPath, "utf-8"), "{ not json");
    // The rest of the wiring still happened
    const sdkConfig = JSON.parse(readFileSync(resolve(dir, "home/.config/config.json"), "utf-8"));
    assert.ok(sdkConfig.subagents?.dreamer);
  });

  it("setupDefaultDreaming survives a missing SDK config and hook", () => {
    const dir = makeMindDir({ sdkConfig: false, hook: false });
    assert.equal(setupDefaultDreaming(dir).schedulesChanged, true);
    assert.ok(readVoluteConfig(dir)?.schedules?.some((s) => s.id === "dream"));
    assert.ok(!existsSync(resolve(dir, "home/.config/config.json")));
  });

  it("setupDefaultDreaming skips the schedule when subagent wiring fails", () => {
    const dir = makeMindDir();
    // Corrupt SDK config makes JSON.parse throw in the subagent step
    writeFileSync(resolve(dir, "home/.config/config.json"), "{ not json");

    const result = setupDefaultDreaming(dir);
    assert.equal(result.schedulesChanged, false);
    assert.ok(result.warnings.length > 0);
    // No dream schedule referencing a subagent that was never wired
    assert.ok(!readVoluteConfig(dir)?.schedules?.some((s) => s.id === "dream"));
  });
});
