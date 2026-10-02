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
  during?: () => unknown;
  /** Run after the events are yielded; an abort by then ends the stream as codex's would. */
  after?: () => unknown;
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
  /** Sessions whose next resumeThread throws, once. */
  failResumeThread: Set<string>;
  /** The config every Codex client was constructed with, by the session it names. */
  clients: { session: string; config: any }[];
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
    const abortIfAsked = () => {
      if (!opts.signal?.aborted) return;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    async function* events() {
      await turn.during?.();
      abortIfAsked();
      for (const e of turn.events ?? []) {
        if (e.type === "thread.started") self._id = e.thread_id;
        yield e;
      }
      if (turn.after) {
        await turn.after();
        abortIfAsked();
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
  constructor(options) {
    this.session = options?.config?.shell_environment_policy?.set?.VOLUTE_SESSION;
    control().clients.push({ session: this.session, config: options?.config ?? {} });
  }
  startThread() {
    if (control().failStartThread.has(this.session)) throw new Error("spawn failed");
    return new Thread(this.session, null);
  }
  resumeThread(id) {
    if (control().failResumeThread.delete(this.session)) throw new Error("resume failed");
    return new Thread(this.session, id);
  }
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
/** What the fake daemon answers a recollection request with; null answers `{}` (a failure). */
let recallEntries: unknown[] | null = null;
const recallQueries: string[] = [];
/** How long the fake daemon takes to answer a recollection request. */
let recallDelayMs = 0;
const control: FakeControl = {
  turns: new Map(),
  calls: [],
  failStartThread: new Set(),
  failResumeThread: new Set(),
  clients: [],
};
type Mind = {
  resolve: (name: string) => {
    handle: (content: unknown[], meta: any, listener?: (e: any) => void) => () => void;
  };
  getContextInfo: () => Promise<{ sessions: { name: string }[] }>;
};
let mind: Mind;
/** A second mind over the same directory, with a context threshold set, for rotation. */
let rotatingMind: Mind;
/** A third, with a dreamer subagent configured. */
let dreamingMind: Mind;

const ROLLOUT_DAY = ["2026", "09", "27"];

function writeRollout(root: string, threadId: string) {
  const dir = resolve(root, ...ROLLOUT_DAY);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `rollout-2026-09-27T10-00-00-${threadId}.jsonl`);
  writeFileSync(path, "{}\n");
  return path;
}

/** A rollout with real conversation in it, which the seeders can build a tail from. */
function writeConversation(root: string, threadId: string) {
  const line = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: "2026-09-20T09:00:00.000Z", type, payload });
  const msg = (role: string, text: string) =>
    line("response_item", { type: "message", role, content: [{ type: "input_text", text }] });
  const path = writeRollout(root, threadId);
  writeFileSync(
    path,
    `${[
      line("session_meta", {
        id: threadId,
        session_id: threadId,
        timestamp: "2026-09-20T09:00:00.000Z",
      }),
      msg("user", "what were we doing"),
      msg("assistant", "tending the tideline"),
    ].join("\n")}\n`,
  );
  return path;
}

function writeArchivePointer(name: string, stamp: string, threadId: string) {
  const archiveDir = resolve(mindDir, ".mind/codex-sessions/archive");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(resolve(archiveDir, `${name}-${stamp}.json`), JSON.stringify({ threadId }));
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
function send(
  session: string,
  content: unknown[] = [{ type: "text", text: "hello" }],
  to: Mind = mind,
  meta: Record<string, unknown> = {},
) {
  const messageId = `m${++messageSeq}`;
  return new Promise<any[]>((done) => {
    const seen: any[] = [];
    to.resolve(session).handle(content, { ...meta, messageId }, (e) => {
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
      if (req.url?.includes("/history/recollection")) {
        recallQueries.push(req.url);
        const entries = recallEntries;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(entries ? { entries } : {}));
        }, recallDelayMs);
        return;
      }
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
  mkdirSync(resolve(mindDir, "home/.local/hooks"), { recursive: true });
  // Says which session it oriented and why that session's thread started.
  writeFileSync(
    resolve(mindDir, "home/.local/hooks/startup-context.sh"),
    [
      'source=$(cat | grep -o \'"source":"[a-z]*"\' | cut -d\'"\' -f4)',
      `printf '{"additionalContext":"ORIENTATION %s %s"}' "$VOLUTE_SESSION" "$source"`,
    ].join("\n"),
  );
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
  // The other root codex reads — `~/.codex/sessions` without CODEX_HOME — kept in the
  // scratch dir rather than the real home.
  process.env.HOME = resolve(mindDir, "fakehome");
  process.chdir(mindDir);

  const { createMind } = await import(resolve(composedDir, "src/agent.ts"));
  mind = createMind({
    systemPrompt: "You are a test mind.",
    cwd: resolve(mindDir, "home"),
    mindDir,
  });
  rotatingMind = createMind({
    systemPrompt: "You are a test mind.",
    cwd: resolve(mindDir, "home"),
    mindDir,
    maxContextTokens: 1000,
  });
  dreamingMind = createMind({
    systemPrompt: "You are a test mind.",
    model: "gpt-test",
    cwd: resolve(mindDir, "home"),
    mindDir,
    subagents: {
      dreamer: { description: "Dreams from your essence.", systemPrompt: "SOUL.md" },
      broken: { description: "Points at nothing.", systemPrompt: "NOPE.md" },
    },
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
    // Not wedged: the next message tries to start a thread again.
    control.failStartThread.delete("no-thread");
    await send("no-thread");
    assert.equal(control.calls.filter((c) => c.session === "no-thread").length, 1);
    assert.equal(eventsFor("no-thread", "error").length, 1);
  });

  it("counts a stream that ends without completing as failed", async () => {
    script("cut-off", {
      events: [
        { type: "thread.started", thread_id: "t-cut-off" },
        { type: "item.started", item: { id: "msg_1", type: "agent_message", text: "" } },
      ],
    });
    await send("cut-off");
    const errors = eventsFor("cut-off", "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].body.content, /ended before codex reported it complete/);
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

  it("tells a mind about a thread its import left behind, once (#1194)", async () => {
    // What prepareCodexImport leaves for a committed thread whose rollout didn't travel.
    const archiveDir = resolve(mindDir, ".mind/codex-sessions/archive");
    mkdirSync(archiveDir, { recursive: true });
    const marked = resolve(archiveDir, "behind-2026-09-28T13-22.json");
    writeFileSync(
      marked,
      JSON.stringify({ threadId: "t-behind", committed: true, rolloutLeftBehind: true }),
    );
    script("behind", {
      events: [
        { type: "thread.started", thread_id: "t-behind-fresh" },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    await send("behind");
    const call = control.calls.find((c) => c.session === "behind");
    assert.equal(call?.threadId, null, "resumed a thread that isn't there");
    await settle();
    const notices = noticesMentioning("behind");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.kind, "context_lost");
    assert.match(notices[0].body.message, /its codex rollout is missing/);
    assert.equal(JSON.parse(readFileSync(marked, "utf-8")).rolloutLeftBehind, undefined);
  });

  it("carries a thread its import left behind when the rollout can still be read", async () => {
    // Same host, shared ~/.codex: the rollout never travelled, but it is readable.
    const behind = "019f5e60-0000-7000-8000-0000000be41d";
    writeConversation(resolve(process.env.HOME ?? "", ".codex/sessions"), behind);
    const archiveDir = resolve(mindDir, ".mind/codex-sessions/archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      resolve(archiveDir, "behind2-2026-09-28T13-22.json"),
      JSON.stringify({ threadId: behind, committed: true, rolloutLeftBehind: true }),
    );
    await send("behind2");
    const call = control.calls.find((c) => c.session === "behind2");
    assert.ok(call?.threadId && call.threadId !== behind, "expected a carried thread");
    assert.match(call.input as string, /restored/i);
    await settle();
    assert.equal(noticesMentioning("behind2").length, 0, "nothing was lost");
  });

  it("stamps a seeded thread's pointer before its first turn runs", async () => {
    const archived = "019f5e60-86f5-7770-80fa-6e9eadf58c24";
    writeArchivePointer("seeded", "2026-09-20T10-00", archived);
    writeConversation(resolve(codexHome, "sessions"), archived);
    let pointerDuringTurn: unknown = null;
    script("seeded", { during: () => (pointerDuringTurn = readPointer("seeded")) });
    await send("seeded");
    const call = control.calls.find((c) => c.session === "seeded");
    assert.ok(call?.threadId && call.threadId !== archived, "expected a freshly seeded thread");
    assert.deepEqual(pointerDuringTurn, { threadId: call?.threadId, committed: true });
    assert.match(call?.input as string, /restored/i, "the seeded note reaches the first turn");
    // The fake daemon's recollection failed, so the seed is the tail alone — and says so.
    assert.doesNotMatch(call?.input as string, /consolidated memory/);
  });

  it("never says a tail was restored when the seeded thread couldn't be resumed", async () => {
    const archived = "019f5e60-0000-7000-8000-00000000fa11";
    writeArchivePointer("seed-fail", "2026-09-20T10-00", archived);
    writeConversation(resolve(codexHome, "sessions"), archived);
    control.failResumeThread.add("seed-fail");
    await send("seed-fail");
    const call = control.calls.find((c) => c.session === "seed-fail");
    assert.equal(call?.threadId, null, "expected a fresh thread");
    assert.doesNotMatch(call?.input as string, /restored/i);
  });

  it("carries a lost thread's own rollout over from the root codex used to read", async () => {
    // A provider switch: the committed thread's rollout is in ~/.codex/sessions, but
    // CODEX_HOME now points codex at .mind/codex. Its own tail is carried across.
    const lost = "019f5e60-0000-7000-8000-00000000ca11";
    writeConversation(resolve(process.env.HOME ?? "", ".codex/sessions"), lost);
    writePointer("switched", lost, true);
    await send("switched");
    const call = control.calls.find((c) => c.session === "switched");
    assert.ok(
      call?.threadId && call.threadId !== lost,
      "expected the tail carried to a new thread",
    );
    const { rolloutVisibleToCodex } = await import(resolve(composedDir, "src/lib/rollout.ts"));
    assert.ok(rolloutVisibleToCodex(call.threadId), "carried rollout isn't where codex reads");
    assert.match(call.input as string, /restored/i, "the first turn says the tail was restored");
    await settle();
    assert.equal(noticesMentioning("switched").length, 0, "nothing was lost");
    assert.deepEqual(readPointer("switched"), { threadId: call.threadId, committed: true });
  });

  it("says how old an archive is when it stands in for a lost thread", async () => {
    const archived = "019f5e60-0000-7000-8000-0000000a2c41";
    const stamp = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 16);
    writeArchivePointer("stand-in", stamp, archived);
    // The archive's rollout is in the other root too: the seed must land where codex reads.
    writeConversation(resolve(process.env.HOME ?? "", ".codex/sessions"), archived);
    writePointer("stand-in", "019f5e60-0000-7000-8000-0000000905e0", true);
    await send("stand-in");
    const call = control.calls.find((c) => c.session === "stand-in");
    assert.ok(call?.threadId && call.threadId !== archived);
    const { rolloutVisibleToCodex } = await import(resolve(composedDir, "src/lib/rollout.ts"));
    assert.ok(rolloutVisibleToCodex(call.threadId), "seed isn't where codex reads");
    await settle();
    const notices = noticesMentioning("stand-in");
    assert.equal(notices.length, 1);
    assert.match(notices[0].body.message, /older session, archived about 3 days ago/);
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
    const [first, failed, retry] = calls.map((c) => c.input as string);
    assert.match(first, /ORIENTATION/, "the session's first turn is oriented");
    assert.doesNotMatch(failed, /ORIENTATION/);
    // The retry is told, in itself, that the thread was reset — and, being a fresh
    // thread, gets the orientation a fresh thread gets.
    assert.ok(retry.endsWith(failed), "the retry carries the same message");
    assert.match(retry, /`vanish` thread couldn't be resumed/);
    assert.equal(retry.match(/ORIENTATION/g)?.length, 1);
    // The retry succeeded and carried the news itself, so nothing failed and there's no
    // notice to repeat it next turn.
    assert.equal(eventsFor("vanish", "error").length, 0);
    await settle();
    assert.equal(noticesMentioning("vanish").length, 0);
    assert.deepEqual(readPointer("vanish"), { threadId: "t-vanish-fresh", committed: true });
  });

  it("carries a thread codex refuses though its rollout is right there (#1194)", async () => {
    // Codex's thread index names a stale path — a moved mind — and codex fails the resume
    // rather than finding the rollout that sits in its own sessions dir. The conversation
    // is on disk, so it is carried onto a fresh thread, not thrown away.
    const stale = "019f5e60-0000-7000-8000-000000057a1e";
    writeConversation(resolve(codexHome, "sessions"), stale);
    writePointer("stale", stale, true);
    script("stale", {
      throws: `Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id ${stale}`,
    });
    await send("stale", [{ type: "text", text: "are you there" }]);
    const calls = control.calls.filter((c) => c.session === "stale");
    assert.equal(calls.length, 2, "expected one retry");
    assert.equal(calls[0].threadId, stale);
    const carried = calls[1].threadId;
    assert.ok(carried && carried !== stale, "expected the retry on a carried thread");
    const { rolloutVisibleToCodex } = await import(resolve(composedDir, "src/lib/rollout.ts"));
    assert.ok(rolloutVisibleToCodex(carried), "carried rollout isn't where codex reads");
    // What the mind is told: its conversation was restored, not lost.
    const retry = calls[1].input as string;
    assert.ok(retry.endsWith(calls[0].input as string), "the retry carries the same message");
    assert.match(retry, /restored/i);
    assert.doesNotMatch(retry, /couldn't be resumed|was lost/);
    assert.equal(eventsFor("stale", "error").length, 0);
    await settle();
    assert.equal(noticesMentioning("stale").length, 0, "nothing was lost");
    assert.deepEqual(readPointer("stale"), { threadId: carried, committed: true });
  });

  it("tells the mind the truth when codex refuses a rollout it can't carry", async () => {
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-refused");
    writePointer("refused", "t-refused", true);
    await send("refused");
    // Present but unreadable as a conversation — nothing a tail can be built from.
    writeFileSync(rollout, "not json\n");
    script(
      "refused",
      { throws: "no rollout found for thread id t-refused" },
      {
        events: [
          { type: "thread.started", thread_id: "t-refused-fresh" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("refused");
    const calls = control.calls.filter((c) => c.session === "refused");
    assert.deepEqual(
      calls.map((c) => c.threadId),
      ["t-refused", "t-refused", null],
    );
    assert.match(
      calls[2].input as string,
      /`refused` thread couldn't be resumed \(codex couldn't find its rollout\)/,
    );
    assert.deepEqual(readPointer("refused"), { threadId: "t-refused-fresh", committed: true });
  });

  it("records the loss as a notice when the retry fails too", async () => {
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-vanish2");
    writePointer("vanish2", "t-vanish2", true);
    await send("vanish2");
    rmSync(rollout);
    script("vanish2", { throws: "no rollout found" }, { throws: "auth failed" });
    await send("vanish2");
    assert.equal(control.calls.filter((c) => c.session === "vanish2").length, 3);
    const errors = eventsFor("vanish2", "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].body.content, "auth failed");
    const notices = noticesMentioning("vanish2");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.kind, "context_lost");
    assert.equal(notices[0].body.thread, undefined);
    assert.ok(
      posted.indexOf(notices[0]) < posted.indexOf(errors[0]),
      "notice recorded before the turn ends",
    );
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

  it("commits shell edits in the pages worktree, which the mind's repo ignores", async () => {
    const pages = resolve(mindDir, "home/pages/_system");
    mkdirSync(pages, { recursive: true });
    const pagesGit = (...args: string[]) =>
      execFileSync("git", args, { cwd: pages, encoding: "utf-8" });
    pagesGit("init", "-q");
    pagesGit("config", "user.email", "test@volute");
    pagesGit("config", "user.name", "test");
    pagesGit("commit", "-q", "--allow-empty", "-m", "init");
    script("pages", { during: () => writeFileSync(resolve(pages, "tide.html"), "<p>tide</p>\n") });
    await send("pages");
    assert.equal(pagesGit("log", "-1", "--format=%s").trim(), "Update tide.html");
    assert.equal(pagesGit("status", "--porcelain"), "");
  });

  it("leaves a sibling turn's half-written file for the last turn to end to commit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const mine = resolve(mindDir, "home/memory/journal/quick.md");
    const theirs = resolve(mindDir, "home/memory/journal/slow.md");
    script("slow", {
      during: async () => {
        entered();
        writeFileSync(theirs, "half of a thou");
        await gate;
        writeFileSync(theirs, "half of a thought, finished\n");
      },
    });
    script("quick", { during: () => writeFileSync(mine, "done\n") });
    const head = git("rev-parse", "HEAD");
    const slow = send("slow");
    await started;
    await send("quick");
    assert.equal(git("rev-parse", "HEAD"), head, "committed while another turn was mid-write");
    release();
    await slow;
    const committed = git("show", "--name-only", "--format=", "HEAD").trim().split("\n");
    assert.deepEqual(committed.sort(), [
      "home/memory/journal/quick.md",
      "home/memory/journal/slow.md",
    ]);
    assert.equal(git("show", "HEAD:home/memory/journal/slow.md"), "half of a thought, finished\n");
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

describe("codex home-changes parsing", () => {
  it("follows a rename reported in the worktree column", async () => {
    const { changedPaths } = await import(resolve(composedDir, "src/lib/home-changes.ts"));
    const repo = mkdtempSync(resolve(tmpdir(), "codex-rename-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(resolve(repo, "old.md"), "same content, long enough to be a rename\n");
    g("add", ".");
    g("commit", "-q", "-m", "init");
    // An intent-to-add path makes git report the rename in the Y column: " R new\0old".
    execFileSync("mv", [resolve(repo, "old.md"), resolve(repo, "new.md")]);
    g("add", "-N", "new.md");
    assert.match(g("status", "--porcelain"), /^ R /m);
    const paths = (await changedPaths(repo)).map((p: string) => p.slice(repo.length + 1)).sort();
    rmSync(repo, { recursive: true, force: true });
    assert.deepEqual(paths, ["new.md", "old.md"]);
  });
});

describe("codex rotation writes where codex reads", () => {
  it("lands the rotated rollout in codex's root, though the live one sits in the other", async () => {
    // The live rollout is where the broad lookup finds it but codex doesn't read — the
    // state a provider switch leaves mid-life. Over the threshold, it rotates; the new
    // rollout must land where the next turn's `codex exec resume` will look.
    const live = "019f5e60-0000-7000-8000-00000000a07a";
    script("rot", {
      during: () => {
        const path = writeConversation(resolve(process.env.HOME ?? "", ".codex/sessions"), live);
        const tokenCount = JSON.stringify({
          timestamp: "2026-09-27T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000 } } },
        });
        writeFileSync(path, `${readFileSync(path, "utf-8")}${tokenCount}\n`);
      },
      events: [
        { type: "thread.started", thread_id: live },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    await send("rot", undefined, rotatingMind);
    await send("rot", undefined, rotatingMind);
    const calls = control.calls.filter((c) => c.session === "rot");
    const rotated = calls[1]?.threadId;
    assert.ok(rotated && rotated !== live, `expected a rotation, got ${rotated}`);
    const { rolloutVisibleToCodex } = await import(resolve(composedDir, "src/lib/rollout.ts"));
    assert.ok(rolloutVisibleToCodex(rotated), "rotated rollout isn't where codex reads");
  });
});

const RECALL = [
  {
    period: "day",
    period_key: "2026-09-19",
    start: "2026-09-19T00:00:00.000Z",
    end: "2026-09-20T00:00:00.000Z",
    content: "I rewrote the pond poem twice.",
    author: "mind",
  },
];

/** The rollout codex would resume for a thread id, as text. */
function rolloutText(threadId: string): string {
  const dir = resolve(codexHome, "sessions");
  const found = execFileSync("find", [dir, "-name", `*${threadId}.jsonl`], { encoding: "utf-8" })
    .trim()
    .split("\n")[0];
  assert.ok(found, `no rollout for ${threadId}`);
  return readFileSync(found, "utf-8");
}

/** A rollout past `rotatingMind`'s threshold, written while the turn runs. */
function overThreshold(threadId: string) {
  return {
    during: () => {
      const path = writeConversation(resolve(codexHome, "sessions"), threadId);
      const tokenCount = JSON.stringify({
        timestamp: "2026-09-27T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000 } } },
      });
      writeFileSync(path, `${readFileSync(path, "utf-8")}${tokenCount}\n`);
    },
    events: [
      { type: "thread.started", thread_id: threadId },
      { type: "turn.completed", usage: USAGE },
    ],
  };
}

describe("codex orients each session as its thread starts (#1199)", () => {
  it("runs startup context for a resumed thread's first turn only, as that session", async () => {
    writeRollout(resolve(codexHome, "sessions"), "t-orient");
    writePointer("orient", "t-orient", true);
    await send("orient");
    await send("orient");
    const [first, second] = control.calls
      .filter((c) => c.session === "orient")
      .map((c) => c.input as string);
    assert.match(first, /ORIENTATION orient resume/);
    assert.doesNotMatch(second, /ORIENTATION/);
  });

  it("orients a brand-new thread as a startup, for its own session", async () => {
    await send("orient-new");
    const call = control.calls.find((c) => c.session === "orient-new");
    assert.match(call?.input as string, /ORIENTATION orient-new startup/);
  });

  it("orients a rotated thread again, as a compaction", async () => {
    script("orient-rot", overThreshold("019f5e60-0000-7000-8000-0000000002a1"));
    await send("orient-rot", undefined, rotatingMind);
    await send("orient-rot", undefined, rotatingMind);
    const [first, afterRotation] = control.calls
      .filter((c) => c.session === "orient-rot")
      .map((c) => c.input as string);
    assert.match(first, /ORIENTATION orient-rot startup/);
    assert.match(afterRotation, /ORIENTATION orient-rot compact/);
  });
});

describe("codex recollection at seams (#1192)", () => {
  it("seeds a waking session with recollection ahead of the tail, and says so", async () => {
    const archived = "019f5e60-0000-7000-8000-00000000ec01";
    writeArchivePointer("recall-wake", "2026-09-21T10-00", archived);
    writeConversation(resolve(codexHome, "sessions"), archived);
    recallEntries = RECALL;
    recallQueries.length = 0;
    try {
      await send("recall-wake");
    } finally {
      recallEntries = null;
    }
    const call = control.calls.find((c) => c.session === "recall-wake");
    assert.ok(call?.threadId && call.threadId !== archived);
    assert.match(call.input as string, /consolidated memory of the days before/);
    const rollout = rolloutText(call.threadId);
    assert.match(rollout, /I rewrote the pond poem twice/);
    assert.ok(rollout.indexOf("pond poem") < rollout.indexOf("tending the tideline"));
    assert.equal(recallQueries.length, 1);
    assert.match(recallQueries[0], /before=2026-09-21T10%3A00/);
  });

  it("holds a message that arrives while recollection loads until the seed is in place", async () => {
    const archived = "019f5e60-0000-7000-8000-00000000ec02";
    writeArchivePointer("recall-slow", "2026-09-21T10-00", archived);
    writeConversation(resolve(codexHome, "sessions"), archived);
    recallEntries = RECALL;
    recallDelayMs = 300;
    try {
      await Promise.all([send("recall-slow"), send("recall-slow")]);
    } finally {
      recallEntries = null;
      recallDelayMs = 0;
    }
    // Both waited for the seed, and — queued together — run as one turn (#1200).
    const calls = control.calls.filter((c) => c.session === "recall-slow");
    assert.equal(calls.length, 1);
    assert.match(calls[0].input as string, /hello[\s\S]*hello/);
    assert.ok(calls[0].threadId && calls[0].threadId !== archived, "ran before the seed landed");
    assert.match(rolloutText(calls[0].threadId), /pond poem/);
  });

  it("seeds a rotation with recollection too", async () => {
    recallEntries = RECALL;
    try {
      script("recall-rot", overThreshold("019f5e60-0000-7000-8000-0000000002a2"));
      await send("recall-rot", undefined, rotatingMind);
      await send("recall-rot", undefined, rotatingMind);
    } finally {
      recallEntries = null;
    }
    const calls = control.calls.filter((c) => c.session === "recall-rot");
    const rotated = calls[1]?.threadId;
    assert.ok(rotated && rotated !== "019f5e60-0000-7000-8000-0000000002a2");
    assert.match(calls[1].input as string, /consolidated memory of the days before/);
    assert.match(rolloutText(rotated), /pond poem/);
  });
});

describe("codex runs the post-tool-use lane, in claude's shape (#1199)", () => {
  it("hands each completed tool call to the mind's hooks before the turn is done", async () => {
    const laneDir = resolve(mindDir, "home/.local/hooks/post-tool-use");
    const record = resolve(mindDir, "post-tool-use.jsonl");
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(
      resolve(laneDir, "record.sh"),
      // Slow enough that a turn which didn't wait for its hooks would be done first.
      `input=$(cat)\nsleep 0.2\nprintf '%s\\n' "$input" >> '${record}'\necho '{"additionalContext":"noted"}'\n`,
    );
    const patched = resolve(mindDir, "home/notes.md");
    try {
      script("lane", {
        events: [
          { type: "thread.started", thread_id: "t-lane" },
          {
            type: "item.completed",
            item: {
              id: "cmd_1",
              type: "command_execution",
              command: "ls",
              aggregated_output: "SOUL.md\n",
              exit_code: 0,
              status: "completed",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "fc_1",
              type: "file_change",
              changes: [
                { path: patched, kind: "add" },
                { path: "MEMORY.md", kind: "update" },
                // Gone: a hook matching Edit would go looking for it.
                { path: "old.md", kind: "delete" },
              ],
              status: "completed",
            },
          },
          // Failed tools aren't reported — claude's PostToolUse runs after success only.
          {
            type: "item.completed",
            item: {
              id: "fc_2",
              type: "file_change",
              changes: [{ path: "never.md", kind: "add" }],
              status: "failed",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "mcp_2",
              type: "mcp_tool_call",
              server: "notes",
              tool: "write",
              arguments: {},
              status: "failed",
              error: { message: "read-only" },
            },
          },
          {
            type: "item.completed",
            item: {
              id: "mcp_1",
              type: "mcp_tool_call",
              server: "notes",
              tool: "search",
              arguments: { q: "tide" },
              status: "completed",
              result: { content: [{ type: "text", text: "found" }], structured_content: null },
            },
          },
          {
            type: "item.completed",
            item: { id: "ws_1", type: "web_search", query: "tides" },
          },
          { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: USAGE },
        ],
      });
      await send("lane");
    } finally {
      rmSync(laneDir, { recursive: true, force: true });
    }
    const calls = readFileSync(record, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      calls.map((c) => c.tool_name),
      ["Bash", "Write", "Edit", "mcp__notes__search", "WebSearch"],
    );
    for (const c of calls) {
      assert.equal(c.hook_event_name, "PostToolUse");
      assert.equal(c.session, "lane");
      assert.equal(c.session_id, "t-lane");
    }
    assert.deepEqual(calls[0].tool_input, { command: "ls" });
    assert.equal(calls[0].tool_response.stdout, "SOUL.md\n");
    assert.equal(calls[0].tool_use_id, "cmd_1");
    assert.equal(calls[1].tool_input.file_path, patched);
    assert.equal(calls[2].tool_input.file_path, resolve(mindDir, "home/MEMORY.md"));
    assert.deepEqual(calls[3].tool_input, { q: "tide" });
    assert.equal(calls[3].tool_response.content[0].text, "found");
    assert.deepEqual(calls[4].tool_input, { query: "tides" });

    const contexts = eventsFor("lane", "context").filter(
      (p) => p.body.metadata?.source === "dynamic:post-tool-use",
    );
    assert.equal(contexts.length, 5);
    const done = eventsFor("lane", "done")[0];
    for (const c of contexts) assert.ok(posted.indexOf(c) < posted.indexOf(done));
  });
});

describe("codex's post-tool-use lane stands aside for an interrupt (#1199)", () => {
  it("skips the hooks an interrupted turn hadn't started yet", async () => {
    const laneDir = resolve(mindDir, "home/.local/hooks/post-tool-use");
    const record = resolve(mindDir, "post-tool-use-interrupt.jsonl");
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(
      resolve(laneDir, "record.sh"),
      `input=$(cat)\nsleep 0.3\nprintf '%s\\n' "$input" >> '${record}'\n`,
    );
    const command = (id: string) => ({
      type: "item.completed",
      item: {
        id,
        type: "command_execution",
        command: "ls",
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
    });
    let interrupting: Promise<unknown> | undefined;
    try {
      script("lane-int", {
        events: [
          { type: "thread.started", thread_id: "t-lane-int" },
          command("c1"),
          command("c2"),
          command("c3"),
        ],
        after: async () => {
          interrupting = send("lane-int", [{ type: "text", text: "stop" }], mind, {
            interrupt: true,
          });
          await settle();
        },
      });
      await send("lane-int");
      await interrupting;
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      rmSync(laneDir, { recursive: true, force: true });
    }
    const ran = readFileSync(record, "utf-8").trim().split("\n");
    assert.equal(ran.length, 1, "only the hook already running when the turn was interrupted");
  });
});

describe("codex folds what arrives mid-turn into that turn (#1200)", () => {
  const text = (t: string) => [{ type: "text", text: t }];
  const donesFor = (session: string) => eventsFor(session, "done").length;

  it("runs messages that arrive during a run as one more run of the same turn, ending once", async () => {
    let later: Promise<unknown>[] = [];
    let donesAtSecondRun = -1;
    script(
      "fold",
      {
        during: async () => {
          later = [send("fold", text("second")), send("fold", text("third"))];
          await settle();
        },
        events: [
          { type: "thread.started", thread_id: "t-fold" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
      {
        during: () => (donesAtSecondRun = donesFor("fold")),
        // codex's counter is cumulative over the thread: this run used 15 more.
        events: [{ type: "turn.completed", usage: { ...USAGE, input_tokens: 25 } }],
      },
    );
    // The first message's done comes only once the late ones have run too.
    await send("fold", text("first"));
    assert.equal(later.length, 2);
    await Promise.all(later);
    const inputs = control.calls.filter((c) => c.session === "fold").map((c) => c.input as string);
    assert.equal(inputs.length, 2, "the two late messages share one run");
    assert.match(inputs[0], /first/);
    assert.match(inputs[1], /second[\s\S]*third/);
    // The slot is held until the queue drains: nothing ended before the second run.
    assert.equal(donesAtSecondRun, 0);
    // Then one `done`, as claude sends for a folded turn.
    assert.equal(donesFor("fold"), 1);
    // It names the turn by the message that led it and covers all three, so the daemon
    // knows every one is finished (#1207).
    const [{ body: done }] = eventsFor("fold", "done");
    assert.equal(new Set(done.covers).size, 3);
    assert.equal(done.messageId, done.covers[0]);
    // And one usage report for the turn, summing both runs (10, then 15 more).
    const usage = eventsFor("fold", "usage").map((p) => p.body.metadata);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 25);
  });

  it("an interrupt aborts the run and takes the next one, still inside the same turn", async () => {
    let interrupting: Promise<any[]> | undefined;
    script("fold-int", {
      during: async () => {
        interrupting = send("fold-int", text("stop, listen"), mind, { interrupt: true });
        await settle();
      },
    });
    const first = await send("fold-int", text("long task"));
    const second = await interrupting;
    const inputs = control.calls
      .filter((c) => c.session === "fold-int")
      .map((c) => c.input as string);
    assert.equal(inputs.length, 2);
    assert.match(inputs[1], /stop, listen/);
    assert.ok(
      first.some((e) => e.type === "done"),
      "the interrupted message's turn ended",
    );
    assert.ok(second?.some((e) => e.type === "done"));
    assert.equal(donesFor("fold-int"), 1);
  });

  it("rotates between runs of a turn, and the next run is told", async () => {
    let later: Promise<unknown> | undefined;
    const live = "019f5e60-0000-7000-8000-0000000002a3";
    const over = overThreshold(live);
    script("fold-rot", {
      ...over,
      during: async () => {
        over.during();
        later = send("fold-rot", text("meanwhile"), rotatingMind);
        await settle();
      },
    });
    await send("fold-rot", text("start"), rotatingMind);
    await later;
    const calls = control.calls.filter((c) => c.session === "fold-rot");
    assert.equal(calls.length, 2);
    assert.ok(
      calls[1].threadId && calls[1].threadId !== live,
      "the second run is on the rotated thread",
    );
    assert.match(calls[1].input as string, /consolidated at the context limit/);
    assert.match(calls[1].input as string, /ORIENTATION fold-rot compact/);
    assert.equal(donesFor("fold-rot"), 1);
  });
});

describe("codex subagents are real, and their usage counts (#1200)", () => {
  const parentConfig = (session: string) =>
    control.clients.find((c) => c.session === session && c.config.model_auto_compact_token_limit)
      ?.config;

  /** Call a subagent tool the way codex would, through the MCP endpoint the thread was given. */
  async function mcp(session: string, body: object, token?: string) {
    const server = parentConfig(session).mcp_servers.subagents;
    const res = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token ?? process.env[server.bearer_token_env_var]}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  }

  it("offers configured subagents to each thread over MCP, and none without config", async () => {
    await send("sub-offer", undefined, dreamingMind);
    const server = parentConfig("sub-offer").mcp_servers.subagents;
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/sub-offer$/);
    assert.equal(server.bearer_token_env_var, "VOLUTE_SUBAGENT_TOKEN");
    assert.equal(server.default_tools_approval_mode, "approve");
    assert.ok(server.tool_timeout_sec > 60, "codex's 60s default would cut a dream short");
    assert.ok(
      !JSON.stringify(parentConfig("sub-offer")).includes(process.env.VOLUTE_SUBAGENT_TOKEN ?? "?"),
    );

    const init = await mcp("sub-offer", {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    const list = await mcp("sub-offer", { id: 2, method: "tools/list" });
    assert.deepEqual(
      list.body.result.tools.map((t: any) => t.name),
      ["dreamer"],
      "a subagent whose prompt file is missing isn't offered",
    );
    assert.match(list.body.result.tools[0].description, /subagent/);
    assert.equal((await mcp("sub-offer", { id: 3, method: "tools/list" }, "wrong")).status, 401);

    await send("no-sub");
    assert.equal(parentConfig("no-sub").mcp_servers, undefined);
  });

  it("runs the subagent as a SOUL-only codex thread and reports its usage on the calling thread", async () => {
    let reply: any;
    let dreamRollout = "";
    script(
      "sub-run",
      {
        during: async () => {
          reply = await mcp("sub-run", {
            id: 7,
            method: "tools/call",
            params: { name: "dreamer", arguments: { prompt: "dream of tides" } },
          });
        },
        events: [
          { type: "thread.started", thread_id: "t-sub-run" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
      // The nested thread's run.
      {
        during: () => {
          dreamRollout = writeRollout(resolve(codexHome, "sessions"), "t-dream");
        },
        events: [
          { type: "thread.started", thread_id: "t-dream" },
          {
            type: "item.completed",
            item: { id: "m", type: "agent_message", text: "the tide came in" },
          },
          { type: "turn.completed", usage: { ...USAGE, input_tokens: 40, output_tokens: 9 } },
        ],
      },
    );
    await send("sub-run", undefined, dreamingMind);
    assert.deepEqual(reply.body.result, { content: [{ type: "text", text: "the tide came in" }] });

    const nested = control.clients.find(
      (c) => c.session === "sub-run" && c.config.project_doc_max_bytes === 0,
    );
    assert.ok(nested, "no nested client");
    assert.equal(nested.config.model_instructions_file, resolve(mindDir, "home/SOUL.md"));
    assert.equal(nested.config.skills.include_instructions, false);
    assert.equal(nested.config.features.multi_agent, false);
    assert.equal(nested.config.mcp_servers, undefined, "a subagent doesn't get subagents");
    // Neither shell is a login shell: /etc/profile would drop home/.local/bin (#1232).
    assert.equal(parentConfig("sub-run").allow_login_shell, false);
    assert.equal(nested.config.allow_login_shell, false);
    const call = control.calls.filter((c) => c.session === "sub-run")[1];
    assert.equal(call.input, "dream of tides");

    // One usage report for the turn: its own run as the aggregate, and the dream in the
    // per-model breakdown the daemon prices (10+40 in, 5+9 out), as pi reports subagents.
    const usage = eventsFor("sub-run", "usage").map((p) => p.body.metadata);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input_tokens, 10);
    assert.equal(usage[0].main_model, "gpt-test");
    assert.deepEqual(usage[0].models, [
      {
        model: "gpt-test",
        input_tokens: 50,
        output_tokens: 14,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ]);
    assert.ok(
      posted.indexOf(eventsFor("sub-run", "usage")[0]) <
        posted.indexOf(eventsFor("sub-run", "done")[0]),
    );
    assert.equal(existsSync(dreamRollout), false, "the subagent's rollout was left behind");
  });

  it("says so when the subagent fails, and reports no usage it didn't have", async () => {
    let reply: any;
    script(
      "sub-fail",
      {
        during: async () => {
          reply = await mcp("sub-fail", {
            id: 8,
            method: "tools/call",
            params: { name: "dreamer", arguments: { prompt: "dream" } },
          });
        },
      },
      { events: [{ type: "turn.failed", error: { message: "usage limit reached" } }] },
    );
    await send("sub-fail", undefined, dreamingMind);
    assert.equal(reply.body.result.isError, true);
    assert.match(reply.body.result.content[0].text, /usage limit reached/);
    // Only the calling run's own usage — the failed dream reported none.
    const usage = eventsFor("sub-fail", "usage").map((p) => p.body.metadata);
    assert.ok(usage.every((m) => m.input_tokens === 10));
  });

  it("stops a subagent still running when the run that called it ends", async () => {
    let reply: Promise<any> | undefined;
    script(
      "sub-orphan",
      {
        during: async () => {
          reply = mcp("sub-orphan", {
            id: 9,
            method: "tools/call",
            params: { name: "dreamer", arguments: { prompt: "a long dream" } },
          });
          await settle();
        },
      },
      // Still dreaming when the caller's run is over.
      { after: () => new Promise((r) => setTimeout(r, 300)) },
    );
    await send("sub-orphan", undefined, dreamingMind);
    const answer = await reply;
    assert.equal(answer.body.result.isError, true);
    assert.match(answer.body.result.content[0].text, /aborted/);
  });

  it("answers a malformed thread name with 400 rather than falling over", async () => {
    await send("sub-bad", undefined, dreamingMind);
    const server = parentConfig("sub-bad").mcp_servers.subagents;
    const res = await fetch(server.url.replace(/sub-bad$/, "%E0%A4%A"), {
      method: "POST",
      headers: { authorization: `Bearer ${process.env[server.bearer_token_env_var]}` },
      body: "{}",
    });
    assert.equal(res.status, 400);
    assert.equal((await mcp("sub-bad", { id: 1, method: "ping" })).status, 200);
  });
});

describe("codex folds only one channel into a run (#1200)", () => {
  const text = (t: string) => [{ type: "text", text: t }];

  it("runs a system event, and each channel, as runs of their own inside one turn", async () => {
    let later: Promise<unknown>[] = [];
    const reply = (t: string) => ({
      events: [
        { type: "item.completed", item: { id: t, type: "agent_message", text: t } },
        { type: "turn.completed", usage: USAGE },
      ],
    });
    script(
      "mix",
      {
        during: async () => {
          later = [
            send("mix", text("tick"), mind, { channel: "event:schedule:77", isEvent: true }),
            send("mix", text("hi from alice"), mind, { channel: "@alice" }),
            send("mix", text("hi from general"), mind, { channel: "#general" }),
            send("mix", text("alice again"), mind, { channel: "@alice" }),
          ];
          await settle();
        },
      },
      reply("to the event"),
      reply("to alice"),
      reply("to general"),
    );
    await send("mix", text("start"), mind, { channel: "#general" });
    await Promise.all(later);
    const inputs = control.calls.filter((c) => c.session === "mix").map((c) => c.input as string);
    assert.equal(inputs.length, 4);
    assert.match(inputs[1], /tick/);
    assert.doesNotMatch(inputs[1], /alice|general/, "an event is never folded with a message");
    assert.match(inputs[1], /system event from your environment/, "and keeps its note");
    assert.match(inputs[2], /hi from alice[\s\S]*alice again/, "one channel's messages fold");
    assert.doesNotMatch(inputs[2], /general|tick/);
    assert.match(inputs[3], /hi from general/);
    const channelOf = (t: string) =>
      eventsFor("mix", "text").find((p) => p.body.content === t)?.body.channel;
    assert.equal(channelOf("to alice"), "@alice");
    assert.equal(channelOf("to general"), "#general");
    assert.equal(eventsFor("mix", "done").length, 1, "still one turn");
  });
});

describe("codex always ends a turn (#1200)", () => {
  it("sends its error and done when the turn breaks, and the thread keeps working", async () => {
    // A directory where the prompt file goes: the turn's prompt write throws.
    const promptPath = resolve(mindDir, ".mind/system-prompt.md");
    rmSync(promptPath, { force: true });
    mkdirSync(promptPath);
    try {
      await send("broken");
    } finally {
      rmSync(promptPath, { recursive: true, force: true });
    }
    assert.equal(eventsFor("broken", "error").length, 1);
    assert.match(eventsFor("broken", "error")[0].body.content, /internal error/);
    assert.equal(eventsFor("broken", "done").length, 1);
    await send("broken");
    assert.equal(eventsFor("broken", "done").length, 2, "the thread was left wedged");
  });
});

describe("codex runs one subagent at a time (#1200)", () => {
  it("makes a second call wait for the first to finish", async () => {
    const order: string[] = [];
    let replies: Promise<any>[] = [];
    script(
      "sub-one",
      {
        during: async () => {
          const call = (id: number) =>
            fetch(
              control.clients.find(
                (c) => c.session === "sub-one" && c.config.model_auto_compact_token_limit,
              ).config.mcp_servers.subagents.url,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${process.env.VOLUTE_SUBAGENT_TOKEN}`,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  method: "tools/call",
                  params: { name: "dreamer", arguments: { prompt: `dream ${id}` } },
                }),
              },
            ).then((r) => r.json());
          replies = [call(1), call(2)];
          await Promise.all(replies);
        },
      },
      {
        during: () => order.push("start 1"),
        after: async () => {
          await new Promise((r) => setTimeout(r, 200));
          order.push("end 1");
        },
        events: [{ type: "turn.completed", usage: USAGE }],
      },
      {
        during: () => order.push("start 2"),
        events: [{ type: "turn.completed", usage: USAGE }],
      },
    );
    await send("sub-one", undefined, dreamingMind);
    assert.deepEqual(order, ["start 1", "end 1", "start 2"]);
  });
});

describe("codex reply instructions follow routes.json (#1205)", () => {
  const replyNotes = (session: string) =>
    eventsFor(session, "context").filter((p) => p.body.metadata?.source === "reply-instructions");

  async function twoTurns(session: string, meta: Record<string, unknown>) {
    await send(session, undefined, mind, meta);
    await send(session, undefined, mind, meta);
    return replyNotes(session);
  }

  const alice = { channel: "@alice", sender: "alice" };

  it("always: the delivered mode reaches the decision and every turn is reminded", async () => {
    const notes = await twoTurns("ri-always", { ...alice, replyInstructions: "always" });
    assert.equal(notes.length, 2);
    assert.match(notes[1].body.content, /volute chat send "@alice"/);
    // A single message's events do name its channel — what the batch case below must not.
    assert.ok(eventsFor("ri-always").some((p) => p.body.channel === "@alice"));
  });

  it("once (the default): only the first turn", async () => {
    assert.equal((await twoTurns("ri-once", alice)).length, 1);
  });

  it("never: no turn", async () => {
    assert.equal((await twoTurns("ri-never", { ...alice, replyInstructions: "never" })).length, 0);
  });

  it("a batch is reminded of its replyChannel, and none of its events name a channel", async () => {
    const notes = await twoTurns("ri-batch", {
      replyChannel: "#garden",
      sender: "alice",
      replyInstructions: "always",
    });
    assert.equal(notes.length, 2);
    assert.match(notes[0].body.content, /volute chat send "#garden"/);
    const events = eventsFor("ri-batch");
    assert.ok(events.length > 0);
    assert.ok(
      events.every((p) => p.body.channel === undefined),
      `no event names a channel: ${JSON.stringify(events.map((p) => p.body.channel))}`,
    );
  });
});

describe("codex the event note and `once` reply instructions are once per model context (#1226)", () => {
  const alice = { channel: "@alice", sender: "alice" };
  const hello = [{ type: "text", text: "hello" }];
  const reminded = (input: unknown) => /volute chat send "@alice"/.test(input as string);
  const inputs = (session: string) =>
    control.calls.filter((c) => c.session === session).map((c) => c.input);

  it("a rotated thread is given them again", async () => {
    script("ri-rot", overThreshold("019f5e60-0000-7000-8000-0000000012a6"));
    await send("ri-rot", hello, rotatingMind, alice);
    await send("ri-rot", hello, rotatingMind, alice);
    assert.deepEqual(inputs("ri-rot").map(reminded), [true, true]);
  });

  it("a fresh thread after a failed first turn is given them again", async () => {
    script(
      "ri-fresh",
      { events: [{ type: "thread.started", thread_id: "t-ri-first" }], throws: "auth failed" },
      {
        events: [
          { type: "thread.started", thread_id: "t-ri-second" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("ri-fresh", hello, mind, alice);
    await send("ri-fresh", hello, mind, alice);
    assert.deepEqual(inputs("ri-fresh").map(reminded), [true, true]);
  });

  it("a retry on a fresh thread that carried them is not given them twice", async () => {
    // The first turn names no one to answer, so the reminder first rides on the turn
    // whose rollout has vanished — and on its retry, onto the fresh thread.
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-ri-vanish");
    writePointer("ri-vanish", "t-ri-vanish", true);
    await send("ri-vanish");
    rmSync(rollout);
    script(
      "ri-vanish",
      { throws: "Codex Exec exited with code 1: no rollout found for thread id t-ri-vanish" },
      {
        events: [
          { type: "thread.started", thread_id: "t-ri-vanish-fresh" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("ri-vanish", hello, mind, alice);
    await send("ri-vanish", hello, mind, alice);
    assert.deepEqual(inputs("ri-vanish").map(reminded), [false, true, true, false]);
  });

  it("a retry that failed gave the fresh thread nothing, so the next turn is reminded", async () => {
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-ri-vanish2");
    writePointer("ri-vanish2", "t-ri-vanish2", true);
    await send("ri-vanish2");
    rmSync(rollout);
    script(
      "ri-vanish2",
      { throws: "no rollout found for thread id t-ri-vanish2" },
      { throws: "auth failed" },
    );
    await send("ri-vanish2", hello, mind, alice);
    await send("ri-vanish2", hello, mind, alice);
    assert.deepEqual(inputs("ri-vanish2").map(reminded), [false, true, true, true]);
  });

  const eventNoted = (input: unknown) => /This is a system event/.test(input as string);
  const event = (n: number) => ({ channel: `event:schedule:${n}`, isEvent: true });

  it("a rotated thread is given the event note again", async () => {
    script("ev-rot", overThreshold("019f5e60-0000-7000-8000-0000000012a8"));
    await send("ev-rot", hello, rotatingMind, event(1));
    await send("ev-rot", hello, rotatingMind, event(2));
    assert.deepEqual(inputs("ev-rot").map(eventNoted), [true, true]);
  });

  it("a retry on a fresh thread that carried the event note is not given it twice", async () => {
    const rollout = writeRollout(resolve(codexHome, "sessions"), "t-ev-vanish");
    writePointer("ev-vanish", "t-ev-vanish", true);
    await send("ev-vanish");
    rmSync(rollout);
    script(
      "ev-vanish",
      { throws: "Codex Exec exited with code 1: no rollout found for thread id t-ev-vanish" },
      {
        events: [
          { type: "thread.started", thread_id: "t-ev-vanish-fresh" },
          { type: "turn.completed", usage: USAGE },
        ],
      },
    );
    await send("ev-vanish", hello, mind, event(1));
    await send("ev-vanish", hello, mind, event(2));
    assert.deepEqual(inputs("ev-vanish").map(eventNoted), [false, true, true, false]);
  });

  it("a thread carried past a stale rollout path is given them again", async () => {
    const stale = "019f5e60-0000-7000-8000-0000000012a7";
    writeConversation(resolve(codexHome, "sessions"), stale);
    writePointer("ri-stale", stale, true);
    await send("ri-stale", hello, mind, alice);
    script("ri-stale", {
      throws: `Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id ${stale}`,
    });
    await send("ri-stale", hello, mind, alice);
    await send("ri-stale", hello, mind, alice);
    const calls = control.calls.filter((c) => c.session === "ri-stale");
    assert.notEqual(calls[2].threadId, stale, "the retry ran on a carried thread");
    assert.deepEqual(
      calls.map((c) => reminded(c.input)),
      [true, false, false, true],
    );
  });
});
