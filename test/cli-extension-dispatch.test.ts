import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The extension dispatch in `src/cli.ts` is the actual #907 repro path — `volute pages
 * list --not-a-real-flag` and `volute pages list gardener` both returned the caller's own
 * list with exit 0. The strictness itself is unit-tested against the parser, but the
 * ~10 lines of glue that call it live in a top-level script that reads argv and exits, so
 * the only honest way to pin them is to run the script.
 *
 * A fake daemon stands in for the real one: `VOLUTE_DAEMON_URL` points the CLI at it and
 * `VOLUTE_MIND_TOKEN` satisfies the auth path, so no `~/.volute` and no real daemon are
 * touched. `dispatched` records whether a request reached the command endpoint at all —
 * the load-bearing claim is not just "it printed an error" but "it refused *before*
 * asking the daemon to do anything."
 *
 * `src/cli.ts` fires a fire-and-forget update check on the way out; it is cached, caught,
 * and does not affect any assertion here.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Metadata shaped like what the daemon serves over /api/v1/extensions/commands. */
const EXT_COMMANDS = {
  pages: {
    commands: {
      list: {
        description: "List pages",
        flags: {
          all: { type: "boolean", description: "All minds' pages" },
          shared: { type: "boolean", description: "Shared pages" },
        },
      },
    },
  },
  // The intentions extension declares a `mind` flag of its own: "show another mind's
  // active intentions". It must reach the handler instead of being eaten as the acting
  // identity, or a declared, --help-advertised flag can never be used.
  intentions: {
    commands: {
      list: {
        description: "List intentions",
        flags: { mind: { type: "string", description: "Show another mind's intentions" } },
      },
    },
  },
};

let server: Server;
let baseUrl: string;
/** Bodies POSTed to a command endpoint, in order. Empty means nothing was dispatched. */
let dispatched: { path: string; body: { args?: string[]; mind?: string } }[] = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/v1/extensions/commands") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(EXT_COMMANDS));
      return;
    }
    // `chat read` support: no conversations (so the target falls through as an id), and a
    // messages endpoint that refuses with a reason, the way the real one does for a
    // malformed cursor.
    if (req.url?.includes("/conversations") && !req.url.includes("/messages")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.url?.includes("/messages")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "before: must be a non-negative integer" }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/api/ext/")) {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        dispatched.push({ path: req.url!, body: JSON.parse(raw || "{}") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: "OK" }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        VOLUTE_DAEMON_URL: baseUrl,
        VOLUTE_MIND_TOKEN: "test-token",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("extension command dispatch is strict before it dispatches (#907)", () => {
  it("refuses an invented flag without asking the daemon to run anything", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "--not-a-real-flag-at-all"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown option: --not-a-real-flag-at-all/);
    assert.match(r.stderr, /known options: --all, --shared/);
    // The original bug printed a real listing. Nothing may be dispatched.
    assert.deepEqual(dispatched, [], "must refuse before reaching the command endpoint");
    assert.doesNotMatch(r.stdout, /OK/);
  });

  it("refuses a stray positional (`volute pages list gardener`)", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "gardener"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown argument: gardener/);
    assert.deepEqual(dispatched, []);
  });

  it("refuses a trailing --mind instead of calling a documented flag unknown", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "--mind"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--mind requires a value/);
    assert.doesNotMatch(r.stderr, /unknown option/);
    assert.deepEqual(dispatched, []);
  });

  it("dispatches a valid invocation, lifting --mind into the acting identity", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "--mind", "gardener", "--all"]);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].body.mind, "gardener");
    // --mind is consumed as the identity and must not be forwarded as a command arg.
    assert.deepEqual(dispatched[0].body.args, ["--all"]);
  });

  it("accepts the --mind=value spelling", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "--mind=gardener"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(dispatched[0].body.mind, "gardener");
    assert.deepEqual(dispatched[0].body.args, []);
  });

  // The MUST-FIX from review: a subcommand that declares its own `mind` flag has to
  // receive it. Hoisting it made intentions' deliberate read-only "show another mind's
  // intentions" feature unusable — advertised in --help, 403 for every caller.
  it("passes --mind through to a subcommand that declares its own mind flag", async () => {
    dispatched = [];
    const r = await runCli(["intentions", "list", "--mind", "gardener"]);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(
      dispatched[0].body.args,
      ["--mind", "gardener"],
      "the declared flag must reach the handler",
    );
    assert.notEqual(
      dispatched[0].body.mind,
      "gardener",
      "and must not be consumed as the acting identity",
    );
  });

  it("surfaces the daemon's refusal text rather than wrapping raw JSON in a status", async () => {
    dispatched = [];
    const r = await runCli(["pages", "list", "--all", "--shared", "--bogus"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown option: --bogus/);
  });
});

describe("chat read surfaces the server's reason, not a bare status", () => {
  // `--before -5` passes the client's integer check and is refused by the server with an
  // explanation. Printing only "400" throws that explanation away and leaves the caller
  // guessing at a refusal that was already spelled out — the same discarded-information
  // failure this PR is about, one layer down.
  it("prints the daemon's error body on a 400", async () => {
    const r = await runCli(["chat", "read", "#system", "--before", "-5", "--mind", "mimsy"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /must be a non-negative integer/);
  });
});
