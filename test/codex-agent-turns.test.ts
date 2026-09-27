import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * The codex template's turn loop, driven end to end: the real composed `agent.ts`, a fake
 * `@openai/codex-sdk` that replays SDK-shaped `ThreadEvent`s, and a fake daemon that
 * records what the mind reports. The fixtures follow the SDK's own types (0.156.1
 * `dist/index.d.ts`) — nothing pinned the loop's parsing to them before, which is how it
 * came to read `item.path` off a file change and `serverName` off an MCP call (#1189),
 * and how a failed turn came to report nothing at all (#1188).
 */

type ScriptedTurn = {
  /** Events to yield. `thread.started` carries the thread's id, as the real SDK does. */
  events?: Record<string, unknown>[];
  /** Thrown after the events, as the SDK throws when `codex exec` exits non-zero. */
  throws?: string;
  /** Run while the turn is "in flight", e.g. to write files like a shell command would. */
  during?: () => void;
};

type RecordedCall = {
  session: string;
  /** The thread id resumed, or null for a thread codex hasn't named yet. */
  threadId: string | null;
  input: unknown;
  /** Which local_image paths existed while the turn ran. */
  imagesPresent: boolean[];
};

type FakeControl = {
  turns: Map<string, ScriptedTurn[]>;
  calls: RecordedCall[];
  failStartThread: Set<string>;
};

const FAKE_SDK = `
const control = () => globalThis.__codexFake;
class Thread {
  constructor(session, id) { this.session = session; this._id = id; }
  get id() { return this._id; }
  async runStreamed(input, opts = {}) {
    const c = control();
    const images = Array.isArray(input) ? input.filter((p) => p.type === "local_image") : [];
    const { existsSync } = await import("node:fs");
    c.calls.push({
      session: this.session,
      threadId: this._id,
      input,
      imagesPresent: images.map((p) => existsSync(p.path)),
    });
    const queue = c.turns.get(this.session) ?? [];
    const turn = queue.shift() ?? { events: [{ type: "turn.completed", usage: usage() }] };
    const self = this;
    async function* events() {
      turn.during?.();
      for (const e of turn.events ?? []) {
        if (e.type === "thread.started") self._id = e.thread_id;
        yield e;
      }
      if (turn.throws) throw new Error(turn.throws);
    }
    return { events: events() };
  }
}
function usage() {
  return { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
}
export class Codex {
  constructor(options) { this.session = options?.config?.shell_environment_policy?.set?.VOLUTE_SESSION; }
  startThread() {
    if (control().failStartThread.has(this.session)) throw new Error("spawn failed");
    return new Thread(this.session, null);
  }
  resumeThread(id) { return new Thread(this.session, id); }
}
`;

type Posted = { path: string; body: any; errorAnswered: boolean };

const USAGE = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
};

let composedDir: string;
let mindDir: string;
let codexHome: string;
let server: Server;
const posted: Posted[] = [];
let lastErrorAnswered = true;
const control: FakeControl = { turns: new Map(), calls: [], failStartThread: new Set() };
let mind: {
  resolve: (name: string) => {
    handle: (content: unknown[], meta: any, listener?: (e: any) => void) => () => void;
  };
  getContextInfo: () => Promise<{ sessions: { name: string }[] }>;
};

const ROLLOUT_DAY = ["2026", "09", "27"];

function writeRollout(root: string, threadId: string) {
  const dir = resolve(root, ...ROLLOUT_DAY);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `rollout-2026-09-27T10-00-00-${threadId}.jsonl`);
  writeFileSync(path, "{}\n");
  return path;
}

function writePointer(name: string, threadId: string, committed: boolean) {
  const dir = resolve(mindDir, ".mind/codex-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ threadId, committed }));
}

function readPointer(name: string): { threadId: string; committed: boolean } | null {
  try {
    return JSON.parse(readFileSync(resolve(mindDir, `.mind/codex-sessions/${name}.json`), "utf-8"));
  } catch {
    return null;
  }
}

function script(session: string, ...turns: ScriptedTurn[]) {
  control.turns.set(session, [...(control.turns.get(session) ?? []), ...turns]);
}

let messageSeq = 0;

/** Send one message to a session and resolve with its broadcast events once it's done. */
function send(session: string, content: unknown[] = [{ type: "text", text: "hello" }]) {
  const messageId = `m${++messageSeq}`;
  return new Promise<any[]>((done) => {
    const seen: any[] = [];
    mind.resolve(session).handle(content, { messageId }, (e) => {
      seen.push(e);
      // The daemon's copy of `done` is still in flight when the listener hears it.
      if (e.type === "done") settle().then(() => done(seen));
    });
  });
}

function eventsFor(session: string, type?: string) {
  return posted.filter(
    (p) =>
      p.path.endsWith("/events") && p.body.session === session && (!type || p.body.type === type),
  );
}

function noticesMentioning(session: string) {
  return posted.filter((p) => p.path.endsWith("/notices") && p.body.message.includes(session));
}

/** Notices land fire-and-forget; give them a beat to arrive. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: mindDir, encoding: "utf-8" });
}

before(async () => {
  const templates = resolve(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templates, "codex").composedDir;
  const sdkDir = resolve(composedDir, "node_modules/@openai/codex-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(
    resolve(sdkDir, "package.json"),
    JSON.stringify({ name: "@openai/codex-sdk", type: "module", exports: "./index.js" }),
  );
  writeFileSync(resolve(sdkDir, "index.js"), FAKE_SDK);
  (globalThis as any).__codexFake = control;

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      posted.push({ path: req.url ?? "", body, errorAnswered: lastErrorAnswered });
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      };
      if (body.type === "error") {
        // Answer an error slowly: a `done` that arrives before this answer was sent
        // without waiting for it.
        lastErrorAnswered = false;
        setTimeout(() => {
          lastErrorAnswered = true;
          answer();
        }, 100);
      } else {
        answer();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");

  mindDir = mkdtempSync(resolve(tmpdir(), "codex-agent-mind-"));
  codexHome = resolve(mindDir, ".mind/codex");
  mkdirSync(resolve(mindDir, "home/memory/journal"), { recursive: true });
  mkdirSync(resolve(mindDir, ".mind"), { recursive: true });
  writeFileSync(resolve(mindDir, "home/SOUL.md"), "You are a test mind.\n");
  copyFileSync(resolve(templates, "_base/gitignore"), resolve(mindDir, ".gitignore"));
  git("init", "-q");
  git("config", "user.email", "test@volute");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  process.env.VOLUTE_DAEMON_PORT = String(addr.port);
  process.env.VOLUTE_MIND = "codex-test";
  process.env.VOLUTE_MIND_TOKEN = "t";
  process.env.CODEX_HOME = codexHome;
  process.chdir(mindDir);

  const { createMind } = await import(resolve(composedDir, "src/agent.ts"));
  mind = createMind({
    systemPrompt: "You are a test mind.",
    cwd: resolve(mindDir, "home"),
    mindDir,
  });
});

after(() => {
  server?.close();
  rmSync(composedDir, { recursive: true, force: true });
  rmSync(mindDir, { recursive: true, force: true });
});

describe("codex turn failures reach the daemon (#1188)", () => {
  it("reports a thrown turn as an error, answered before done", async () => {
    script("fail-throw", { throws: "Codex Exec exited with code 1: token could not be refreshed" });
    await send("fail-throw");
    const errors = eventsFor("fail-throw", "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].body.content, /token could not be refreshed/);
    const done = eventsFor("fail-throw", "done");
    assert.equal(done.length, 1);
    assert.ok(done[0].errorAnswered, "done was sent before the error was acknowledged");
    assert.ok(posted.indexOf(errors[0]) < posted.indexOf(done[0]));
  });

  it("reports turn.failed once, though the stream also throws after it", async () => {
    script("fail-event", {
      events: [
        { type: "thread.started", thread_id: "t-fail-event" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "usage limit reached" } },
      ],
      throws: "Codex Exec exited with code 1",
    });
    await send("fail-event");
    const errors = eventsFor("fail-event", "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].body.content, "usage limit reached");
  });

  it("does not count a stream error the turn recovered from", async () => {
    script("recovered", {
      during: () => writeRollout(resolve(codexHome, "sessions"), "t-recovered"),
      events: [
        { type: "thread.started", thread_id: "t-recovered" },
        { type: "error", message: "Reconnecting... 1/5" },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    await send("recovered");
    assert.equal(eventsFor("recovered", "error").length, 0);
    assert.equal(control.calls.filter((c) => c.session === "recovered").length, 1);
    assert.equal(eventsFor("recovered", "done").length, 1);
  });

  it("counts a stream error the turn never got past", async () => {
    script("unrecovered", {
      events: [
        { type: "thread.started", thread_id: "t-unrecovered" },
        { type: "error", message: "stream disconnected" },
      ],
    });
    await send("unrecovered");
    const errors = eventsFor("unrecovered", "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].body.content, "stream disconnected");
  });

  it("reports a message it had no thread to run on", async () => {
    control.failStartThread.add("no-thread");
    const seen = await send("no-thread");
    assert.equal(control.calls.filter((c) => c.session === "no-thread").length, 0);
    assert.equal(eventsFor("no-thread", "error").length, 1);
    assert.ok(eventsFor("no-thread", "done")[0].errorAnswered);
    assert.equal(seen.at(-1).type, "done");
  });
});

describe("codex resume checks the rollout codex will read (#1188, #985)", () => {
  it("resumes a pointer whose rollout is under CODEX_HOME", async () => {
    writeRollout(resolve(codexHome, "sessions"), "t-alive");
    writePointer("alive", "t-alive", true);
    await send("alive");
    const call = control.calls.find((c) => c.session === "alive");
    assert.equal(call?.threadId, "t-alive");
    await settle();
    assert.equal(noticesMentioning("alive").length, 0);
  });

  it("drops a committed pointer codex can't resume, starts fresh, and says so", async () => {
    // The rollout exists, but under ~/.codex-style other root: the provider changed, so
    // CODEX_HOME points somewhere this file isn't. The context panel's broad search would
    // still find it; codex won't.
    writeRollout(resolve(mindDir, "elsewhere/sessions"), "t-moved");
    writePointer("moved", "t-moved", true);
    script("moved", {
      events: [
        { type: "thread.started", thread_id: "t-moved-fresh" },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    await send("moved");
    const call = control.calls.find((c) => c.session === "moved");
    assert.equal(call?.threadId, null, "resumed a thread codex can't find");
    await settle();
    const notices = noticesMentioning("moved");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.kind, "context_lost");
    assert.equal(notices[0].body.thread, undefined, "context_lost must be mind-level (#768)");
    assert.deepEqual(readPointer("moved"), { threadId: "t-moved-fresh", committed: true });
  });

  it("drops an uncommitted pointer without claiming a loss (#769)", async () => {
    writePointer("never-turned", "t-never", false);
    await send("never-turned");
    assert.equal(control.calls.find((c) => c.session === "never-turned")?.threadId, null);
    await settle();
    assert.equal(noticesMentioning("never-turned").length, 0);
  });

  it("recovers a thread whose rollout vanished mid-life instead of wedging it", async () => {
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-vanish");
    writePointer("vanish", "t-vanish", true);
    await send("vanish");
    rmSync(rollout);
    script(
      "vanish",
      { throws: "Codex Exec exited with code 1: no rollout found for thread id t-vanish" },
      {
        events: [
          { type: "thread.started", thread_id: "t-vanish-fresh" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("vanish", [{ type: "text", text: "are you there" }]);
    const calls = control.calls.filter((c) => c.session === "vanish");
    assert.deepEqual(
      calls.map((c) => c.threadId),
      ["t-vanish", "t-vanish", null],
      "expected the failed resume to be retried once on a fresh thread",
    );
    assert.deepEqual(calls[2].input, calls[1].input, "the retry carries the same message");
    // The retry succeeded, so the turn isn't reported failed — but the loss is.
    assert.equal(eventsFor("vanish", "error").length, 0);
    await settle();
    const notices = noticesMentioning("vanish");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.kind, "context_lost");
    assert.deepEqual(readPointer("vanish"), { threadId: "t-vanish-fresh", committed: true });
  });

  it("drops a brand-new thread whose first turn failed before it wrote a rollout", async () => {
    script(
      "first-fail",
      { events: [{ type: "thread.started", thread_id: "t-first" }], throws: "auth failed" },
      {
        events: [
          { type: "thread.started", thread_id: "t-second" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("first-fail");
    // Nothing was ever said in it: no notice, no retry, the failure itself reported.
    assert.equal(control.calls.filter((c) => c.session === "first-fail").length, 1);
    assert.equal(eventsFor("first-fail", "error").length, 1);
    await send("first-fail");
    assert.equal(
      control.calls.filter((c) => c.session === "first-fail").at(-1)?.threadId,
      null,
      "the next turn resumed a thread with no rollout",
    );
    await settle();
    assert.equal(noticesMentioning("first-fail").length, 0);
  });

  it("stamps a pointer committed only once a turn completes", async () => {
    script("stamp", {
      events: [{ type: "thread.started", thread_id: "t-stamp" }],
      throws: "boom",
      during: () => writeRollout(resolve(codexHome, "sessions"), "t-stamp"),
    });
    await send("stamp");
    assert.deepEqual(readPointer("stamp"), { threadId: "t-stamp", committed: false });
    await send("stamp");
    assert.deepEqual(readPointer("stamp"), { threadId: "t-stamp", committed: true });
  });
});

describe("codex ephemeral sessions", () => {
  it("drops a new-* session once its turn is over", async () => {
    await send("new-123-abc");
    const names = (await mind.getContextInfo()).sessions.map((s) => s.name);
    assert.ok(!names.includes("new-123-abc"), `still holding ${names.join(", ")}`);
    assert.ok(names.includes("main"), "persistent sessions stay");
  });
});

describe("codex item parsing follows the SDK's ThreadItem shapes (#1189)", () => {
  it("names MCP calls by server and tool, and reports their result", async () => {
    const call = {
      id: "item_1",
      type: "mcp_tool_call",
      server: "notes",
      tool: "search",
      arguments: { q: "tide" },
      status: "in_progress",
    };
    script("mcp", {
      events: [
        { type: "thread.started", thread_id: "t-mcp" },
        { type: "item.started", item: call },
        {
          type: "item.completed",
          item: {
            ...call,
            status: "completed",
            result: {
              content: [{ type: "text", text: "two notes found" }],
              structured_content: null,
            },
          },
        },
        {
          type: "item.completed",
          item: {
            id: "item_2",
            type: "mcp_tool_call",
            server: "notes",
            tool: "write",
            arguments: {},
            status: "failed",
            error: { message: "read-only" },
          },
        },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    const seen = await send("mcp");
    const use = eventsFor("mcp", "tool_use")[0].body;
    assert.equal(use.metadata.name, "mcp:notes/search");
    assert.deepEqual(JSON.parse(use.content), { q: "tide" });
    const results = eventsFor("mcp", "tool_result").map((p) => p.body);
    assert.equal(results[0].content, "two notes found");
    assert.equal(results[0].metadata.tool_use_id, "item_1");
    assert.equal(results[0].metadata.is_error, false);
    assert.equal(results[1].content, "read-only");
    assert.equal(results[1].metadata.is_error, true);
    assert.deepEqual(seen.find((e) => e.type === "tool_use")?.input, { q: "tide" });
  });

  it("streams agent_message text from item.text", async () => {
    const item = { id: "msg_1", type: "agent_message", text: "" };
    script("text", {
      events: [
        { type: "thread.started", thread_id: "t-text" },
        { type: "item.started", item },
        { type: "item.updated", item: { ...item, text: "Hel" } },
        { type: "item.completed", item: { ...item, text: "Hello." } },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    const seen = await send("text");
    assert.equal(
      seen
        .filter((e) => e.type === "text")
        .map((e) => e.content)
        .join(""),
      "Hello.",
    );
  });
});

describe("codex auto-commit (#1189)", () => {
  it("commits what a turn changed under home/, from shell commands and file changes alike", async () => {
    const journal = resolve(mindDir, "home/memory/journal/2026-09-27.md");
    const patched = resolve(mindDir, "home/MEMORY.md");
    script("commit", {
      // A shell command writes the journal (no file_change item); a patch writes MEMORY.md;
      // a scratch file lands outside the home/ allowlist.
      during: () => {
        writeFileSync(journal, "today\n");
        writeFileSync(patched, "remembered\n");
        writeFileSync(resolve(mindDir, "home/scratch.txt"), "not for history\n");
      },
      events: [
        { type: "thread.started", thread_id: "t-commit" },
        {
          type: "item.completed",
          item: {
            id: "fc_1",
            type: "file_change",
            changes: [{ path: patched, kind: "add" }],
            status: "completed",
          },
        },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    await send("commit");
    const committed = git("show", "--name-only", "--format=%s", "HEAD").trim().split("\n");
    assert.match(committed[0], /^Update /);
    assert.ok(committed.includes("home/memory/journal/2026-09-27.md"), committed.join(", "));
    assert.ok(committed.includes("home/MEMORY.md"), committed.join(", "));
    assert.ok(!committed.includes("home/scratch.txt"), "committed a gitignored file");
    assert.equal(git("status", "--porcelain", "--", "home/memory", "home/MEMORY.md"), "");
    const result = eventsFor("commit", "tool_result")[0].body;
    assert.equal(result.content, `add: ${patched}`);
  });

  it("commits a file changed after the turn, on shutdown", async () => {
    const late = resolve(mindDir, "home/memory/journal/late.md");
    writeFileSync(late, "cut short\n");
    await (mind as any).flushFileChanges();
    assert.match(git("log", "-1", "--format=%s"), /late\.md/);
  });
});

describe("codex images (#1189)", () => {
  it("passes an image through as local_image input, and removes the file after", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    await send("image", [
      { type: "text", text: "look" },
      { type: "image", media_type: "image/png", data: png },
    ]);
    const call = control.calls.find((c) => c.session === "image");
    assert.ok(Array.isArray(call?.input), "input should carry the image");
    const parts = call?.input as { type: string; path?: string; text?: string }[];
    const image = parts.find((p) => p.type === "local_image");
    assert.ok(image?.path?.startsWith(resolve(mindDir, ".mind")), "image written outside .mind");
    assert.deepEqual(call?.imagesPresent, [true]);
    assert.equal(existsSync(image?.path ?? ""), false, "image file left behind");
  });

  it("tells the mind about an image it couldn't pass through", async () => {
    await send("bad-image", [
      { type: "text", text: "look" },
      { type: "image", media_type: "image/tiff", data: "AAAA" },
    ]);
    const call = control.calls.find((c) => c.session === "bad-image");
    assert.equal(typeof call?.input, "string");
    assert.match(call?.input as string, /1 image was attached.*couldn't be passed through/);
  });
});
