import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// The per-turn session slug rides the SDK subprocess env: createStream passes
// `env: { ...sdkEnv, VOLUTE_SESSION: session.name }`, so every Bash child of a
// stream inherits its own session's slug (verified empirically under seatbelt
// sandbox — env set at SDK spawn reaches Bash tool children). There is no seam
// to intercept `query()` in a unit test, so pin the source instead: losing this
// line silently reverts X-Volute-Thread to "no session tag at all", and turn
// attribution falls back to marker correlation (#1017).
describe("per-stream session env binding", () => {
  it("claude template binds VOLUTE_SESSION in the per-stream SDK env", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../templates/claude/src/agent.ts"),
      "utf-8",
    );
    assert.match(src, /env:\s*\{\s*\.\.\.sdkEnv,\s*VOLUTE_SESSION:\s*session\.name\s*\}/);
  });

  it("pi template binds VOLUTE_SESSION per session in its bash tool", () => {
    // pi runs tools in-process, so a process-global slug names whichever session
    // wrote it last — a send from one thread was stamped with a sibling's turn
    // (#1173). Each session (and each subagent it runs) gets its own bash tool
    // whose spawnHook sets the slug; registered as `bash`, it replaces the built-in.
    const dir = resolve(import.meta.dirname, "../templates/pi/src");
    const bash = readFileSync(resolve(dir, "lib/session-bash.ts"), "utf-8");
    assert.match(bash, /spawnHook:[\s\S]*VOLUTE_SESSION:\s*sessionName/);
    const agent = readFileSync(resolve(dir, "agent.ts"), "utf-8");
    assert.match(
      agent,
      /customTools:\s*\[createSessionBashTool\(options\.cwd,\s*session\.name,\s*settingsManager\)\]/,
    );
    assert.match(agent, /sessionName:\s*session\.name/, "subagents get the parent session");
    const subagents = readFileSync(resolve(dir, "lib/subagents.ts"), "utf-8");
    assert.match(
      subagents,
      /customTools:\s*\[\s*createSessionBashTool\(context\.cwd,\s*context\.sessionName,\s*settingsManager\),?\s*\]/,
    );
  });

  it("codex template binds VOLUTE_SESSION per session in its shell environment", () => {
    // One Codex client per session, its shell_environment_policy carrying the slug.
    // The shared home/.zshenv this used to be written into was last-writer-wins
    // (#1173) — and zsh sources that file after the policy env is applied, so a
    // VOLUTE_SESSION line there would override the per-session value.
    const src = readFileSync(
      resolve(import.meta.dirname, "../templates/codex/src/agent.ts"),
      "utf-8",
    );
    assert.match(src, /set:\s*\{\s*ZDOTDIR:\s*options\.cwd,\s*VOLUTE_SESSION:\s*sessionName\s*\}/);
    assert.doesNotMatch(src, /\bcodex\.(start|resume)Thread\(/, "a thread on a shared client");
    assert.doesNotMatch(src, /export VOLUTE_SESSION=/, "codex template still writes .zshenv");
  });

  it("template code carries no process-global or file-based session carrier", () => {
    for (const file of [
      "../templates/_base/src/lib/router.ts",
      "../templates/_base/src/lib/daemon-client.ts",
      "../templates/pi/src/agent.ts",
      "../templates/codex/src/agent.ts",
    ]) {
      const src = readFileSync(resolve(import.meta.dirname, file), "utf-8");
      assert.doesNotMatch(src, /process\.env\.VOLUTE_SESSION\s*=/, `${file} writes the global`);
      assert.ok(!src.includes("current-session"), `${file} still touches current-session`);
    }
  });

  it("no reader falls back to the current-session file", () => {
    // Every X-Volute-Thread reader is env-only. A reintroduced file fallback
    // resurrects the racy whole-process carrier this fix removed (#1017).
    for (const file of [
      "../packages/cli/src/lib/daemon-client.ts",
      "../packages/daemon/src/lib/platforms/volute.ts",
      "../templates/_base/src/lib/daemon-client.ts",
      "../templates/_base/.init/.local/bin/volute",
    ]) {
      const src = readFileSync(resolve(import.meta.dirname, file), "utf-8");
      assert.ok(!src.includes("current-session"), `${file} reads the current-session file`);
    }
  });
});
