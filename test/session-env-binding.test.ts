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

  it("pi template sets its process-global carrier at dispatch", () => {
    // pi's tools spawn children from the mind process itself — there is no
    // per-session subprocess to bind env to, so the process-global (correct for
    // a single active turn, last-writer-wins across concurrent ones) is pi's
    // only carrier. Losing this line leaves pi minds with no X-Volute-Thread
    // at all: paths without a marker fallback record turn_id NULL silently.
    const src = readFileSync(resolve(import.meta.dirname, "../templates/pi/src/agent.ts"), "utf-8");
    assert.match(src, /process\.env\.VOLUTE_SESSION\s*=\s*sessionName/);
  });

  it("shared template code carries no process-global or file-based session carrier", () => {
    for (const file of [
      "../templates/_base/src/lib/router.ts",
      "../templates/_base/src/lib/daemon-client.ts",
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
