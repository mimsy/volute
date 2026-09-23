import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { mindEnvPath, writeEnv } from "../packages/daemon/src/lib/config/env.js";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { composeMindEnv, wrapMindServer } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { runMindScript } from "../packages/daemon/src/lib/daemon/mind-script.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { SandboxUnavailableError } from "../packages/daemon/src/lib/mind/sandbox.js";
import type { IsolationMode } from "../packages/daemon/src/lib/util/mind-env.js";

/**
 * A mind should know the shape of its world (#368). One that hits EACCES outside
 * its directory, or finds a variable silently undefined, can't tell forbidden from
 * broken unless someone told it where the walls are. The daemon names the
 * isolation it actually spawned the mind under; the startup hook turns that into
 * a line — and says nothing about walls that aren't there.
 */

const HOOK_PATH = resolve(process.cwd(), "templates/_base/.init/.local/hooks/startup-context.ts");
const execFileAsync = promisify(execFile);

describe("composeMindEnv isolation mode", () => {
  const mindName = `env-368-${process.pid}`;

  function compose(isolationMode: IsolationMode) {
    return composeMindEnv({
      name: mindName,
      baseName: mindName,
      dir: `/tmp/${mindName}`,
      port: 4197,
      mindToken: "tok",
      isolationMode,
    });
  }

  for (const mode of ["sandbox", "user", "none"] as const) {
    it(`hands the mind its mode: ${mode}`, () => {
      assert.equal(compose(mode).VOLUTE_ISOLATION_MODE, mode);
    });
  }

  it("lets the real mode outrank one the mind wrote into its own env", async () => {
    // "none" is the case that matters: were it left unset rather than written,
    // a planted "sandbox" would survive and describe a cage the mind isn't in.
    writeEnv(mindEnvPath(mindName), { VOLUTE_ISOLATION_MODE: "sandbox" });
    try {
      assert.equal(compose("none").VOLUTE_ISOLATION_MODE, "none");
    } finally {
      writeEnv(mindEnvPath(mindName), {});
    }
  });
});

/**
 * The mode must be the one the mind actually runs under, not the one config names:
 * config can say "sandbox" while a process runs bare. In unit tests the sandbox
 * runtime is never initialized, which is exactly the "enabled but unavailable"
 * state — so these pin every way "sandbox" config can end up as a bare process.
 */
describe("isolation mode follows the actual wrap", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;
  const origOptional = process.env.VOLUTE_SANDBOX_OPTIONAL;
  const configPath = () => resolve(voluteSystemDir(), "config.json");
  const mindName = `env-368-wrap-${process.pid}`;

  function sandboxConfig() {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    _resetConfigCache();
  }

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
    if (origOptional === undefined) delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    else process.env.VOLUTE_SANDBOX_OPTIONAL = origOptional;
    writeEnv(mindEnvPath(mindName), {});
  });

  const server = (template?: string) =>
    wrapMindServer("/usr/bin/node", ["server.ts"], {
      name: mindName,
      template,
      dir: `/tmp/${mindName}`,
      allowWrite: [`/tmp/${mindName}`],
    });

  it("reports none for a server the sandbox degraded to bare (VOLUTE_SANDBOX_OPTIONAL=1)", async () => {
    sandboxConfig();
    process.env.VOLUTE_SANDBOX_OPTIONAL = "1";
    const r = await server("claude");
    assert.equal(r.cmd, "/usr/bin/node");
    assert.equal(r.isolationMode, "none");
  });

  it("reports none for a codex mind's server, which is exempt from the sandbox", async () => {
    // No opt-out set: a non-codex mind here would fail closed (next test), so a
    // codex mind getting through at all shows the exemption was taken.
    sandboxConfig();
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const r = await server("codex");
    assert.equal(r.cmd, "/usr/bin/node");
    assert.equal(r.isolationMode, "none");
  });

  it("still fails closed for a non-codex server when the sandbox is unavailable", async () => {
    sandboxConfig();
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    await assert.rejects(() => server("claude"), SandboxUnavailableError);
  });

  it("reports none when the sandbox is switched off (VOLUTE_SANDBOX=0)", async () => {
    sandboxConfig();
    process.env.VOLUTE_SANDBOX = "0";
    assert.equal((await server("claude")).isolationMode, "none");
  });

  it("tells a daemon-run script its real mode, over one the mind planted", async () => {
    // Scheduled scripts and lifecycle hooks get their env from buildMindScriptEnv,
    // not composeMindEnv; the same guarantee has to hold there.
    sandboxConfig();
    process.env.VOLUTE_SANDBOX_OPTIONAL = "1";
    writeEnv(mindEnvPath(mindName), { VOLUTE_ISOLATION_MODE: "sandbox" });
    const out = await runMindScript("bash", ["-c", 'printf "%s" "$VOLUTE_ISOLATION_MODE"'], {
      mindName,
      dir: `/tmp/${mindName}`,
    });
    assert.equal(out, "none");
  });
});

describe("startup-context environment line", () => {
  /** Run the hook with no daemon port, so both of its fetches are skipped. */
  async function runHook(mode: string | undefined): Promise<string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.VOLUTE_DAEMON_PORT;
    delete env.VOLUTE_MIND_DIR;
    delete env.VOLUTE_SYSTEM_NAME;
    delete env.VOLUTE_ISOLATION_MODE;
    env.VOLUTE_MIND = "dizzy";
    if (mode !== undefined) env.VOLUTE_ISOLATION_MODE = mode;
    const child = execFileAsync("node", ["--import", "tsx", HOOK_PATH], {
      encoding: "utf-8",
      env,
    });
    child.child.stdin?.end(JSON.stringify({ source: "startup" }));
    const { stdout } = await child;
    return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
  }

  it("names the sandbox's walls", async () => {
    const ctx = await runHook("sandbox");
    assert.match(ctx, /You run in a sandbox: you can write only inside your own directory/);
    assert.match(ctx, /not something broken/);
    assert.doesNotMatch(ctx, /own OS user/);
    assert.match(ctx, /environment variables come from an allowlist/);
  });

  it("names per-user isolation", async () => {
    const ctx = await runHook("user");
    assert.match(ctx, /You run as your own OS user/);
    assert.doesNotMatch(ctx, /sandbox/);
    assert.match(ctx, /environment variables come from an allowlist/);
  });

  it("claims no isolation wall when there is none, but still names the env allowlist", async () => {
    // The allowlist applies in every mode — buildMindBaseEnv runs unconditionally.
    const ctx = await runHook("none");
    assert.doesNotMatch(ctx, /sandbox|own OS user|permission error/);
    assert.match(ctx, /environment variables come from an allowlist/);
  });

  it("says nothing about the environment when the daemon didn't say", async () => {
    const ctx = await runHook(undefined);
    assert.doesNotMatch(ctx, /sandbox|own OS user|allowlist/);
  });
});
