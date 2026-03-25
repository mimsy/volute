import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const voluteHome = process.env.VOLUTE_HOME!;

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("npx", ["tsx", "src/cli.ts", ...args], {
      timeout: 15000,
      env: { ...process.env, VOLUTE_HOME: voluteHome },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function combined(r: { stdout: string; stderr: string }): string {
  return r.stdout + r.stderr;
}

describe("CLI --help", () => {
  before(() => {
    // Ensure setup is "complete" so gated commands don't bail
    const systemDir = resolve(voluteHome, "system");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(resolve(systemDir, "config.json"), JSON.stringify({ setupCompleted: true }));
  });

  // Top-level
  it("volute --help shows top-level help", async () => {
    const r = await runCli("--help");
    const out = combined(r);
    assert.ok(out.includes("volute"), "should mention volute");
    assert.ok(out.includes("mind"), "should list mind command");
    assert.ok(out.includes("chat"), "should list chat command");
  });

  // Dispatchers
  it("volute mind --help lists subcommands", async () => {
    const r = await runCli("mind", "--help");
    const out = combined(r);
    assert.ok(out.includes("create"), "should list create");
    assert.ok(out.includes("start"), "should list start");
    assert.ok(out.includes("stop"), "should list stop");
    assert.ok(out.includes("history"), "should list history");
    assert.ok(out.includes("split"), "should list split");
  });

  it("volute chat --help lists subcommands", async () => {
    const r = await runCli("chat", "--help");
    const out = combined(r);
    assert.ok(out.includes("send"), "should list send");
    assert.ok(out.includes("list"), "should list list");
    assert.ok(out.includes("read"), "should list read");
    assert.ok(out.includes("bridge"), "should list bridge");
  });

  it("volute clock --help lists subcommands", async () => {
    const r = await runCli("clock", "--help");
    const out = combined(r);
    assert.ok(out.includes("add"), "should list add");
    assert.ok(out.includes("list"), "should list list");
    assert.ok(out.includes("sleep"), "should list sleep");
    assert.ok(out.includes("wake"), "should list wake");
  });

  it("volute skill --help lists all subcommands", async () => {
    const r = await runCli("skill", "--help");
    const out = combined(r);
    assert.ok(out.includes("install"), "should list install");
    assert.ok(out.includes("remove"), "should list remove");
    assert.ok(out.includes("publish"), "should list publish");
    assert.ok(out.includes("defaults"), "should list defaults");
    assert.ok(out.includes("uninstall"), "should list uninstall");
  });

  it("volute env --help lists subcommands", async () => {
    const r = await runCli("env", "--help");
    const out = combined(r);
    assert.ok(out.includes("set"), "should list set");
    assert.ok(out.includes("get"), "should list get");
    assert.ok(out.includes("list"), "should list list");
    assert.ok(out.includes("remove"), "should list remove");
  });

  it("volute seed --help lists subcommands", async () => {
    const r = await runCli("seed", "--help");
    const out = combined(r);
    assert.ok(out.includes("create"), "should list create");
    assert.ok(out.includes("sprout"), "should list sprout");
    assert.ok(out.includes("check"), "should list check");
  });

  it("volute service --help shows subcommands", async () => {
    const r = await runCli("service", "--help");
    const out = combined(r);
    assert.ok(out.includes("status"), "should list status");
  });

  it("volute config --help lists subcommands", async () => {
    const r = await runCli("config", "--help");
    const out = combined(r);
    assert.ok(out.includes("models"), "should list models");
    assert.ok(out.includes("providers"), "should list providers");
    assert.ok(out.includes("status"), "should list status");
  });

  // Leaf commands — verify --help shows flags/args and does NOT execute
  it("volute mind create --help shows flags without executing", async () => {
    const r = await runCli("mind", "create", "--help");
    const out = combined(r);
    assert.ok(out.includes("--template"), "should show --template flag");
    assert.ok(out.includes("Create a new mind"), "should show description");
    assert.ok(!out.includes("Missing required"), "should NOT show missing arg error");
  });

  it("volute chat send --help shows flags", async () => {
    const r = await runCli("chat", "send", "--help");
    const out = combined(r);
    assert.ok(out.includes("--wait"), "should show --wait flag");
    assert.ok(out.includes("target"), "should show target arg");
  });

  it("volute up --help shows flags", async () => {
    const r = await runCli("up", "--help");
    const out = combined(r);
    assert.ok(out.includes("--port"), "should show --port flag");
    assert.ok(out.includes("--foreground"), "should show --foreground flag");
  });

  it("volute mind export --help shows all include flags", async () => {
    const r = await runCli("mind", "export", "--help");
    const out = combined(r);
    assert.ok(out.includes("--include-src"), "should show --include-src");
    assert.ok(out.includes("--include-connectors"), "should show --include-connectors");
    assert.ok(out.includes("--include-env"), "should show --include-env");
    assert.ok(out.includes("--all"), "should show --all");
  });

  it("volute mind split --help shows flags", async () => {
    const r = await runCli("mind", "split", "--help");
    const out = combined(r);
    assert.ok(out.includes("--from"), "should show --from flag");
    assert.ok(out.includes("--soul"), "should show --soul flag");
    assert.ok(out.includes("--json"), "should show --json flag");
  });

  it("volute seed create --help shows flags", async () => {
    const r = await runCli("seed", "create", "--help");
    const out = combined(r);
    assert.ok(out.includes("--template"), "should show --template flag");
    assert.ok(out.includes("--model"), "should show --model flag");
  });

  // Verify -h works too
  it("volute mind -h works same as --help", async () => {
    const r = await runCli("mind", "-h");
    const out = combined(r);
    assert.ok(out.includes("create"), "should list create");
    assert.ok(out.includes("Manage minds"), "should show description");
  });
});
