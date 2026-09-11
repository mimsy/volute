import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { run as createRun } from "../packages/cli/src/commands/create.js";
import { run as seedCreateRun } from "../packages/cli/src/commands/seed-create.js";
import { chooseModel, resolveModel } from "../packages/cli/src/lib/choose-model.js";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";

/**
 * #1034: `volute mind create` had no `--model`, so a host (or the spirit acting for
 * one) could not say which model a mind is born on — the flag was refused and the
 * mind came up on whatever the template hardcoded, unannounced.
 *
 * These tests pin the contract that replaced it. `mind create` resolves without ever
 * asking: `--model`, else the admin's configured default, else the spirit's model when
 * it belongs to this template's provider, else nothing — and it says out loud what the
 * mind woke up on. `seed create` keeps the picker, for a host who came to be asked.
 */

type Captured = { path: string; body: Record<string, unknown> };

/** Models the daemon's enabled-model list answers with, per test. */
let servedModels: unknown[] = [];
/** Status the enabled-model list answers with — the route is admin-only in reality. */
let modelsStatus = 200;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

/**
 * A stand-in daemon. `daemonFetch` prefers VOLUTE_DAEMON_URL over daemon.json, so
 * pointing it here needs no session file and no real mind creation.
 */
async function startStub(captured: Captured[]): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/api/v1/system/ai/models") {
      res.writeHead(modelsStatus, { "Content-Type": "application/json" });
      res.end(modelsStatus === 200 ? JSON.stringify(servedModels) : JSON.stringify({}));
      return;
    }
    const raw = await readBody(req);
    captured.push({ path, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "pinned", port: 4100 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.env.VOLUTE_DAEMON_URL = `http://127.0.0.1:${port}`;
  return server;
}

interface CliResult {
  logs: string[];
  errors: string[];
  exitCode?: number;
  /** The command was still running when `timeoutMs` elapsed — i.e. it blocked. */
  hung?: boolean;
}

/**
 * Run a CLI command with stdin/stdout captured and process.exit stubbed.
 *
 * `timeoutMs` gives up on a command that never returns and reports `hung`. The race
 * lives inside the try, not around the call: a timer that resolved outside would leave
 * console, stdin and the exit mock swapped for the rest of the file, so the very
 * regression this catches would also blind every test after it.
 */
async function runCli(
  run: (args: string[]) => Promise<unknown>,
  args: string[],
  stdin?: string,
  tty = false,
  timeoutMs?: number,
): Promise<CliResult> {
  let exitCode: number | undefined;
  const exitMock = mock.method(process, "exit", (code?: number) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));

  const origStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  // promptLine reads raw bytes off process.stdin, so feed Buffers, not strings.
  const fake = stdin ? Readable.from([Buffer.from(stdin)]) : Readable.from([]);
  // rawPrompt calls setRawMode on anything claiming to be a terminal.
  if (tty) Object.assign(fake, { isTTY: true, setRawMode: () => fake });
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });

  let hung = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (timeoutMs === undefined) {
      await run(args);
    } else {
      const ran = await Promise.race([
        run(args).then(() => "returned"),
        new Promise<string>((res) => {
          timer = setTimeout(() => res("hung"), timeoutMs);
        }),
      ]);
      hung = ran === "hung";
    }
  } catch {
    // the exit mock throws
  } finally {
    if (timer) clearTimeout(timer);
    console.log = origLog;
    console.error = origErr;
    exitMock.mock.restore();
    process.stderr.write = origStderr;
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
  return { logs, errors, exitCode, hung };
}

/**
 * Same capture, for calling the helper directly rather than through a command.
 * `tty` makes the fake stdin look like a terminal, which is what routes resolveModel
 * to the picker — rawPrompt calls setRawMode on anything claiming to be one.
 */
async function withFakeStdin<T>(
  stdin: string | undefined,
  fn: () => Promise<T>,
  tty = false,
): Promise<T> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  const origStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const fake = stdin ? Readable.from([Buffer.from(stdin)]) : Readable.from([]);
  if (tty) {
    Object.assign(fake, { isTTY: true, setRawMode: () => fake });
  }
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    console.log = origLog;
    process.stderr.write = origStderr;
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
}

/** Clear every source resolveModel consults, so a test states its own premises. */
function resetModelConfig(): void {
  const config = readGlobalConfig();
  delete config.spiritModel;
  delete config.mindDefaults;
  writeGlobalConfig(config);
}

const MODELS = [
  { id: "kimi-k2.5", name: "Kimi K2.5", provider: "openrouter", enabled: true },
  { id: "glm-4.7", name: "GLM 4.7", provider: "openrouter", enabled: true },
  { id: "off-model", name: "Disabled", provider: "openrouter", enabled: false },
];

/** The spirit's model, by provider, in the qualified form resolveTemplate can read. */
const SPIRIT_PI = "openrouter:kimi-k2.5";
const SPIRIT_CLAUDE = "anthropic:claude-opus-5";

function setSpiritModel(model: string): void {
  const config = readGlobalConfig();
  config.spiritModel = model;
  writeGlobalConfig(config);
}

function setAdminDefault(model: string): void {
  const config = readGlobalConfig();
  config.mindDefaults = { cognition: { model } };
  writeGlobalConfig(config);
}

/** The model on the create POST the stub captured, and whether one was sent at all. */
function sentModel(captured: Captured[]): unknown {
  const post = captured.find((c) => c.path === "/api/v1/minds");
  assert.ok(post, `no create POST captured; got ${captured.map((c) => c.path).join(", ")}`);
  return post.body.model;
}

// Serialized: every test shares process.env, process.stdin and the global config.
describe("mind create --model (#1034)", { concurrency: 1 }, () => {
  let server: Server;
  let captured: Captured[];
  const savedUrl = process.env.VOLUTE_DAEMON_URL;

  beforeEach(async () => {
    captured = [];
    servedModels = MODELS;
    server = await startStub(captured);
    resetModelConfig();
  });

  afterEach(() => {
    server.close();
    if (savedUrl === undefined) delete process.env.VOLUTE_DAEMON_URL;
    else process.env.VOLUTE_DAEMON_URL = savedUrl;
  });

  it("sends --model through to the daemon's create request", async () => {
    const r = await runCli(createRun, [
      "pinned",
      "--template",
      "pi",
      "--model",
      "openrouter:glm-4.7",
    ]);
    assert.equal(r.exitCode, undefined, `unexpected exit: ${r.errors.join("\n")}`);
    assert.equal(sentModel(captured), "openrouter:glm-4.7");
    assert.match(r.logs.join("\n"), /Model: openrouter:glm-4\.7/, "should name the model");
  });

  /**
   * The regression this command must never have: a blocking prompt. `mind create` is
   * run by cron, by provisioning scripts, by `docker exec -it` (a pty, so isTTY is
   * true), and by the spirit. promptLine resolves only on a newline byte and has no
   * end-of-stream handler, so a question asked here is a hang. Raced against a timer
   * so a regression fails rather than stalling the suite.
   */
  it("never prompts, even at a terminal with nothing configured", async () => {
    const r = await runCli(createRun, ["pinned", "--template", "pi"], undefined, true, 3000);
    assert.ok(!r.hung, "mind create must not block on a prompt");
    assert.equal(r.exitCode, undefined, `unexpected exit: ${r.errors.join("\n")}`);
    assert.equal(sentModel(captured), undefined, "nothing configured means nothing to send");
    assert.match(r.logs.join("\n"), /Model: the pi template's default/);
  });

  /**
   * `mindDefaults.cognition.model` (Settings → Mind Defaults) is applied by createMind
   * as `body.model ?? cog.model`. Sending a model over it would make the setting
   * unreachable, so the CLI stays quiet and names it instead.
   */
  it("leaves an admin-configured default to the daemon, and says so", async () => {
    setAdminDefault("openrouter:glm-4.7");
    setSpiritModel(SPIRIT_PI);

    const r = await runCli(createRun, ["pinned", "--template", "pi"]);
    assert.equal(sentModel(captured), undefined, "the daemon already has the answer");
    assert.match(r.logs.join("\n"), /Model: openrouter:glm-4\.7 \(system default\)/);
  });

  /** The default template and the commonest invocation, previously uncovered. */
  it("names the claude template's default on a bare create", async () => {
    const r = await runCli(createRun, ["pinned", "--template", "claude"]);
    assert.equal(r.exitCode, undefined, `unexpected exit: ${r.errors.join("\n")}`);
    assert.equal(sentModel(captured), undefined);
    assert.match(r.logs.join("\n"), /Model: the claude template's default/);
  });

  it("borrows the spirit's model when it belongs to this template's provider", async () => {
    setSpiritModel(SPIRIT_PI);

    const r = await runCli(createRun, ["pinned", "--template", "pi"]);
    assert.equal(sentModel(captured), SPIRIT_PI);
    assert.match(r.logs.join("\n"), /the spirit's model/);
  });

  /**
   * The inference that had to be guarded: a codex mind handed the spirit's Anthropic
   * model writes a model its runtime cannot call into config.json and comes up mute,
   * displacing the template default that would have worked.
   */
  it("does not hand a codex mind the spirit's Anthropic model", async () => {
    setSpiritModel(SPIRIT_CLAUDE);

    const r = await runCli(createRun, ["pinned", "--template", "codex"]);
    assert.equal(sentModel(captured), undefined, "an incompatible model is worse than none");
    assert.match(r.logs.join("\n"), /Model: the codex template's default/);
  });
});

describe("seed create keeps its picker", { concurrency: 1 }, () => {
  let server: Server;
  let captured: Captured[];
  const savedUrl = process.env.VOLUTE_DAEMON_URL;

  beforeEach(async () => {
    captured = [];
    servedModels = MODELS;
    server = await startStub(captured);
    resetModelConfig();
  });

  afterEach(() => {
    server.close();
    if (savedUrl === undefined) delete process.env.VOLUTE_DAEMON_URL;
    else process.env.VOLUTE_DAEMON_URL = savedUrl;
  });

  it("asks a host at a terminal and sends what they picked", async () => {
    const r = await runCli(seedCreateRun, ["pinned", "--template", "pi"], "2\n", true);
    assert.equal(r.exitCode, undefined, `unexpected exit: ${r.errors.join("\n")}`);
    // Second *enabled* model — the disabled one is not offered.
    assert.equal(sentModel(captured), "openrouter:glm-4.7");
  });

  it("does not ask when nobody is at a terminal", async () => {
    const r = await runCli(seedCreateRun, ["pinned", "--template", "pi"], undefined, false, 3000);
    assert.ok(!r.hung, "a closed stdin must not be asked a question");
    assert.equal(sentModel(captured), undefined);
  });

  it("sends the same model as mind create, for the same flags", async () => {
    await runCli(createRun, ["pinned", "--template", "pi", "--model", "openrouter:glm-4.7"]);
    const fromCreate = sentModel(captured);

    captured.length = 0;
    await runCli(seedCreateRun, ["pinned", "--template", "pi", "--model", "openrouter:glm-4.7"]);
    assert.equal(fromCreate, "openrouter:glm-4.7");
    assert.equal(sentModel(captured), fromCreate, "both must resolve the flag identically");
  });

  /** Parity on the resolved path too — the half that would drift silently. */
  it("resolves the same model as mind create with no --model at all", async () => {
    setSpiritModel(SPIRIT_PI);

    await runCli(createRun, ["pinned", "--template", "pi"]);
    const fromCreate = sentModel(captured);

    captured.length = 0;
    await runCli(seedCreateRun, ["pinned", "--template", "pi"]);
    assert.equal(fromCreate, SPIRIT_PI);
    assert.equal(sentModel(captured), fromCreate, "both must resolve identically with no flag");
  });
});

describe("resolveModel (shared by mind create and seed create)", { concurrency: 1 }, () => {
  beforeEach(() => {
    resetModelConfig();
  });

  it("an explicit model wins on every template", async () => {
    for (const template of ["claude", "pi", "codex"]) {
      const r = await resolveModel(template, "anthropic:claude-opus-5");
      assert.equal(r.send, "anthropic:claude-opus-5", `template ${template}`);
      assert.equal(r.mayAsk, false);
    }
  });

  /**
   * The claude template is left alone — but it is not modelless: _base's config.json
   * pins a model and templates/claude/ ships no override. Saying "the install default"
   * here would hide exactly what #1034 was filed about, on the default template.
   */
  it("names the claude template's own default rather than claiming there is none", async () => {
    const r = await resolveModel("claude", undefined);
    assert.equal(r.send, undefined);
    assert.equal(r.mayAsk, false);
    assert.match(r.describe, /claude template's default/);
    assert.doesNotMatch(r.describe, /install default/);
  });

  it("short-circuits on the admin default for every caller, claude included", async () => {
    setAdminDefault("openrouter:glm-4.7");
    setSpiritModel(SPIRIT_PI);

    for (const template of ["claude", "pi", "codex"]) {
      const r = await resolveModel(template, undefined);
      assert.equal(r.send, undefined, `template ${template}`);
      assert.equal(r.mayAsk, false, `template ${template} must not be asked over a default`);
      assert.match(r.describe, /system default/);
    }
  });

  it("qualifies the spirit's model for a pi mind", async () => {
    setSpiritModel(SPIRIT_PI);
    const r = await resolveModel("pi", undefined);
    assert.equal(r.send, SPIRIT_PI);
    assert.equal(r.mayAsk, false);
  });

  it("refuses the spirit's model when the providers differ", async () => {
    setSpiritModel(SPIRIT_CLAUDE);
    const r = await resolveModel("codex", undefined);
    assert.equal(r.send, undefined, "a codex mind cannot call an Anthropic model");
    assert.equal(r.mayAsk, true, "nothing decided, so a host may still be asked");
  });

  it("leaves the template default standing when nothing is configured", async () => {
    const r = await resolveModel("pi", undefined);
    assert.equal(r.send, undefined);
    assert.equal(r.mayAsk, true);
    assert.match(r.describe, /pi template's default/);
  });
});

describe("chooseModel", { concurrency: 1 }, () => {
  let server: Server;
  let captured: Captured[];
  const savedUrl = process.env.VOLUTE_DAEMON_URL;

  beforeEach(async () => {
    captured = [];
    servedModels = MODELS;
    server = await startStub(captured);
  });

  afterEach(() => {
    server.close();
    if (savedUrl === undefined) delete process.env.VOLUTE_DAEMON_URL;
    else process.env.VOLUTE_DAEMON_URL = savedUrl;
  });

  it("returns nothing when no model is enabled", async () => {
    servedModels = [{ id: "x", name: "X", provider: "openrouter", enabled: false }];
    const { daemonFetch } = await import("../packages/cli/src/lib/daemon-client.js");
    const model = await withFakeStdin(undefined, () => chooseModel(daemonFetch));
    assert.equal(model, undefined);
  });

  /** Run chooseModel against a fetch that just returns `status`, capturing stderr. */
  async function refusalFor(status: number, useDaemonFetch: boolean): Promise<string> {
    // Imported before anything is swapped, so a throw here cannot leak a stub.
    const { daemonFetch } = await import("../packages/cli/src/lib/daemon-client.js");
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    const exitMock = mock.method(process, "exit", (code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    modelsStatus = status;
    const fetcher = useDaemonFetch
      ? daemonFetch
      : async () => new Response("{}", { status, headers: { "Content-Type": "application/json" } });
    try {
      await chooseModel(fetcher);
    } catch {
      // the exit mock throws
    } finally {
      console.error = origErr;
      exitMock.mock.restore();
      modelsStatus = 200;
    }
    return errors.join("\n");
  }

  /**
   * The route is admin-only, so a non-200 here is almost always authorization —
   * "Is the daemon running?" sent a mind looking at the wrong thing entirely.
   * 403 is what actually arrives through daemonFetch, which intercepts 401 itself;
   * 401 is checked through a plain fetch, for a caller that supplies its own.
   */
  it("names authorization, not a dead daemon, on a 403", async () => {
    const stderr = await refusalFor(403, true);
    assert.match(stderr, /admin account/, stderr);
  });

  it("names authorization on a 401 too", async () => {
    const stderr = await refusalFor(401, false);
    assert.match(stderr, /admin account/, stderr);
  });

  it("still blames the daemon on a status that is not about authorization", async () => {
    const stderr = await refusalFor(500, false);
    assert.match(stderr, /Is the daemon running\?/, stderr);
  });
});
