import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
 * The claude template's turn ends, driven end to end: the real composed `agent.ts`, a fake
 * `@anthropic-ai/claude-agent-sdk` whose `query` answers each prompt the channel yields,
 * and a fake daemon that records what the mind reports. Every path on which a stream stops
 * must end its turn with a `done` naming the deliveries it took — one it forgets holds the
 * daemon's session busy and its turn slot taken (#1207).
 *
 * The fake runs the UserPromptSubmit hooks before answering a prompt, as the CLI does, and
 * sends `system/init` once at the start of a stream. That ordering — not the real SDK's —
 * is what the hook's `messageId` is checked against here.
 */

type Turn = {
  /** End the stream before taking the next prompt, as a CLI that exits would. */
  end?: boolean;
  /** Context tokens the answer reports — past the threshold, the turn ends in a rotation. */
  inputTokens?: number;
  /** Throw once the prompt is taken, before answering it — a stream that dies mid-turn. */
  throws?: boolean;
  /** Run just before that throw. */
  beforeThrow?: () => void;
  /** The SDK tries to auto-compact twice in this turn: blocked once, then let through. */
  compacts?: boolean;
};

const FAKE_SDK = `
const control = () => globalThis.__claudeFake;
export function query({ prompt, options }) {
  const input = prompt[Symbol.asyncIterator]();
  const signal = options.abortController?.signal;
  const aborted = () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  };
  const sid = control().sessionIds.get(options.env?.VOLUTE_SESSION) ?? "sess-1";
  async function* stream() {
    yield { type: "system", subtype: "init", model: "fake-model", session_id: sid };
    for (;;) {
      const turn = control().turns.get(options.env?.VOLUTE_SESSION)?.shift() ?? {};
      if (turn.end) return;
      // The real SDK stops waiting for input once aborted; a rotation aborts an idle stream.
      if (signal?.aborted) throw aborted();
      const next = await Promise.race([
        input.next(),
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(aborted()), { once: true }),
        ),
      ]);
      if (next.done) return;
      const text = next.value.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\\n");
      const byPrompt = control().byPrompt.find((t) => text.includes(t.match));
      if (byPrompt) Object.assign(turn, byPrompt.turn);
      for (const matcher of options.hooks?.UserPromptSubmit ?? []) {
        for (const hook of matcher.hooks) {
          await hook(
            { hook_event_name: "UserPromptSubmit", prompt: text, session_id: sid },
            undefined,
            { signal: new AbortController().signal },
          );
        }
      }
      for (let pass = 0; turn.compacts && pass < 2; pass++) {
        for (const matcher of options.hooks?.PreCompact ?? []) {
          for (const hook of matcher.hooks) {
            await hook({ hook_event_name: "PreCompact", trigger: "auto" }, undefined, {
              signal: new AbortController().signal,
            });
          }
        }
      }
      if (signal?.aborted) throw aborted();
      const gate = control().gates.findIndex((g) => text.includes(g.match));
      if (gate !== -1) {
        const [held] = control().gates.splice(gate, 1);
        held.onTaken();
        await held.release;
      }
      if (turn.throws) {
        turn.beforeThrow?.();
        throw new Error("stream died");
      }
      control().prompts.push({ session: options.env?.VOLUTE_SESSION, text });
      yield {
        type: "assistant",
        session_id: sid,
        message: {
          usage: { input_tokens: turn.inputTokens ?? 10, output_tokens: 1 },
          content: [{ type: "text", text: "ok" }],
        },
      };
      yield { type: "result", subtype: "success", session_id: sid, usage: { input_tokens: 10, output_tokens: 1 } };
      if (signal?.aborted) throw aborted();
    }
  }
  const s = stream();
  s.interrupt = async () => {
    if (control().rejectInterrupt) throw new Error("interrupt refused");
  };
  return s;
}
`;

let composedDir: string;
let mindDir: string;
let captureDir: string;
let server: Server;
const posted: { path: string; body: any }[] = [];
/** Scripted turns, by the session whose stream runs them. */
const control: {
  turns: Map<string, Turn[]>;
  prompts: { session: string; text: string }[];
  /** The SDK session id a session's streams report, by session; "sess-1" if unset. */
  sessionIds: Map<string, string>;
  /** Hold the answer to the first prompt containing `match` until `release` settles. */
  gates: { match: string; onTaken: () => void; release: Promise<void> }[];
  /** Make the query's `interrupt()` reject, as the SDK's can. */
  rejectInterrupt: boolean;
  /**
   * Turns keyed by the prompt they answer, laid over the session's scripted turn. Unlike
   * `turns`, these don't depend on how many turns an aborted stream took off the list.
   */
  byPrompt: { match: string; turn: Turn }[];
} = {
  turns: new Map(),
  prompts: [],
  sessionIds: new Map(),
  gates: [],
  rejectInterrupt: false,
  byPrompt: [],
};

/** Hold the answer to the prompt containing `match`: resolves once it is taken. */
function hold(match: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const taken = new Promise<void>((onTaken) => {
    control.gates.push({ match, onTaken, release: released });
  });
  return { taken, release };
}

type Mind = {
  resolve: (name: string) => {
    handle: (content: unknown[], meta: any, listener?: (e: any) => void) => () => void;
  };
  reapAllSessions: () => Promise<void>;
};
let createMind: (options: any) => Mind;

function dones(session: string) {
  return posted.filter(
    (p) => p.path.endsWith("/events") && p.body.session === session && p.body.type === "done",
  );
}

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(posted)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function send(mind: Mind, session: string, messageId: string) {
  mind.resolve(session).handle([{ type: "text", text: `hello ${messageId}` }], { messageId });
}

function newMind(extra: Record<string, unknown> = {}): Mind {
  return createMind({
    loadSystemPrompt: () => "You are a test mind.",
    cwd: resolve(mindDir, "home"),
    abortController: new AbortController(),
    sessionsDir: resolve(mindDir, ".mind/sessions"),
    recollection: false,
    sessionIdleMinutes: 0,
    ...extra,
  });
}

before(async () => {
  const templates = resolve(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templates, "claude").composedDir;
  const sdkDir = resolve(composedDir, "node_modules/@anthropic-ai/claude-agent-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(
    resolve(sdkDir, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk",
      type: "module",
      exports: "./index.js",
    }),
  );
  writeFileSync(resolve(sdkDir, "index.js"), FAKE_SDK);
  (globalThis as any).__claudeFake = control;

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      posted.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");

  mindDir = mkdtempSync(resolve(tmpdir(), "claude-agent-mind-"));
  captureDir = resolve(mindDir, "captured");
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(resolve(mindDir, ".mind/sessions"), { recursive: true });
  const hooks = resolve(mindDir, "home/.local/hooks/pre-prompt");
  mkdirSync(hooks, { recursive: true });
  // Records the input each pre-prompt hook run is handed.
  writeFileSync(
    resolve(hooks, "capture.sh"),
    `cat > "${captureDir}/$(date +%s%N)-$$.json"\necho '{}'\n`,
  );

  process.env.VOLUTE_DAEMON_PORT = String(addr.port);
  process.env.VOLUTE_MIND = "claude-test";
  process.env.VOLUTE_MIND_TOKEN = "t";
  process.env.HOME = resolve(mindDir, "fakehome");
  ({ createMind } = await import(resolve(composedDir, "src/agent.ts")));
});

after(() => {
  server?.close();
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
  if (mindDir) rmSync(mindDir, { recursive: true, force: true });
});

describe("claude: every turn ends with a done naming what it took (#1207)", () => {
  it("the pre-prompt hook is handed the delivery whose prompt it runs for", async () => {
    const mind = newMind();
    send(mind, "hooked", "d1");
    await waitFor(() => dones("hooked").length === 1, "d1's done");
    send(mind, "hooked", "d2");
    await waitFor(() => dones("hooked").length === 2, "d2's done");
    const inputs = readdirSync(captureDir)
      .sort()
      .map((f) => JSON.parse(readFileSync(resolve(captureDir, f), "utf-8")))
      .filter((i) => i.session === "hooked");
    assert.deepEqual(
      inputs.map((i) => i.messageId),
      ["d1", "d2"],
    );
    assert.deepEqual(
      dones("hooked").map((d) => [d.body.messageId, d.body.covers]),
      [
        ["d1", ["d1"]],
        ["d2", ["d2"]],
      ],
    );
  });

  it("a stream that ends with input still queued ends that input's turn", async () => {
    const mind = newMind();
    control.turns.set("ended", [{}, { end: true }]);
    // Both queued before the stream starts: d2 would get a turn of its own, but the
    // stream ends after d1's.
    send(mind, "ended", "d1");
    send(mind, "ended", "d2");
    await waitFor(() => dones("ended").length === 2, "both dones");
    const [first, second] = dones("ended").map((d) => d.body);
    assert.deepEqual(first.covers, ["d1"]);
    assert.deepEqual(second.covers, ["d2"], "the stream's end covers what it never reached");
    assert.notEqual(second.endsTurn, false);
  });

  it("a rotation that fails carries the input it held into a fresh session, rather than dropping it", async () => {
    // Over the context threshold, so d1's turn ends in a rotation — which fails, as there
    // is no transcript to rotate. d2, queued behind d1, runs in the fresh session.
    const mind = newMind({ maxContextTokens: 100 });
    control.turns.set("rotated", [{ inputTokens: 1000 }]);
    send(mind, "rotated", "d1");
    send(mind, "rotated", "d2");
    await waitFor(() => dones("rotated").length === 2, "both dones");
    const [first, second] = dones("rotated").map((d) => d.body);
    assert.deepEqual([first.messageId, first.covers], ["d1", ["d1"]]);
    assert.deepEqual([second.messageId, second.covers], ["d2", ["d2"]]);
    const answered = control.prompts.filter((p) => p.session === "rotated").map((p) => p.text);
    assert.equal(answered.length, 2, "d2 was answered, not just declared done");
    assert.match(answered[1], /hello d2/);
  });

  it("a stream that dies mid-turn redelivers its input to the fresh stream", async () => {
    const mind = newMind();
    control.turns.set("resumed", [{ throws: true }]);
    send(mind, "resumed", "d1");
    await waitFor(() => dones("resumed").length === 1, "d1's done");
    const [done] = dones("resumed").map((d) => d.body);
    assert.deepEqual([done.messageId, done.covers], ["d1", ["d1"]]);
    const answered = control.prompts.filter((p) => p.session === "resumed").map((p) => p.text);
    assert.equal(answered.length, 1);
    assert.match(answered[0], /hello d1/);
  });

  it("a stream that dies while its session is torn down leaves redelivery to the reaper", async () => {
    // Shutdown reaps the session in the window before the dead stream's catch runs. The
    // reaper owns what the channel holds: recovering it there too would deliver it twice.
    const mind = newMind();
    control.turns.set("torn", [{ throws: true, beforeThrow: () => void mind.reapAllSessions() }]);
    send(mind, "torn", "d1");
    await waitFor(
      () => posted.some((p) => p.body.content === 'session "torn": stream consumer ended'),
      "the stream consumer to end",
    );
    const answered = control.prompts.filter((p) => p.session === "torn");
    assert.equal(answered.length, 0, "the dying session did not run d1 again itself");
  });
});

describe("claude: reply instructions follow routes.json (#1205)", () => {
  const replyNotes = (session: string) =>
    posted.filter(
      (p) =>
        p.path.endsWith("/events") &&
        p.body.session === session &&
        p.body.type === "context" &&
        p.body.metadata?.source === "reply-instructions",
    );

  async function twoTurns(session: string, meta: Record<string, unknown>) {
    const mind = newMind();
    for (const id of [`${session}-1`, `${session}-2`]) {
      mind.resolve(session).handle([{ type: "text", text: `hello ${id}` }], {
        ...meta,
        messageId: id,
      });
      await waitFor(() => dones(session).some((d) => d.body.messageId === id), `${id}'s done`);
    }
    return replyNotes(session);
  }

  const alice = { channel: "@alice", sender: "alice" };

  it("always: the delivered mode reaches the hook and every turn is reminded", async () => {
    const notes = await twoTurns("ri-always", { ...alice, replyInstructions: "always" });
    assert.equal(notes.length, 2);
    assert.match(notes[1].body.content, /volute chat send "@alice"/);
    // A single message's events do name its channel — what the batch case below must not.
    const text = posted.filter(
      (p) => p.path.endsWith("/events") && p.body.session === "ri-always" && p.body.type === "text",
    );
    assert.ok(text.length > 0 && text.every((p) => p.body.channel === "@alice"));
  });

  it("once (the default): only the first turn", async () => {
    assert.equal((await twoTurns("ri-once", alice)).length, 1);
  });

  it("never: no turn", async () => {
    assert.equal((await twoTurns("ri-never", { ...alice, replyInstructions: "never" })).length, 0);
  });

  it("a batch is reminded of its replyChannel, and none of its events name a channel", async () => {
    // A batch can span several channels; an event carrying one would be echoed there
    // (echoText) — the reply meant for @bob, posted in #garden.
    const notes = await twoTurns("ri-batch", {
      replyChannel: "#garden",
      sender: "alice",
      replyInstructions: "always",
    });
    assert.equal(notes.length, 2);
    assert.match(notes[0].body.content, /volute chat send "#garden"/);
    const events = posted.filter(
      (p) => p.path.endsWith("/events") && p.body.session === "ri-batch",
    );
    assert.ok(
      events.some((p) => p.body.type === "text"),
      "the turns said something",
    );
    assert.ok(
      events.every((p) => p.body.channel === undefined),
      `no event names a channel: ${JSON.stringify(events.map((p) => p.body.channel))}`,
    );
  });
});

describe("claude: the event note and `once` reply instructions are once per model context (#1226)", () => {
  const replyNotes = (session: string) =>
    posted.filter(
      (p) =>
        p.path.endsWith("/events") &&
        p.body.session === session &&
        p.body.type === "context" &&
        p.body.metadata?.source === "reply-instructions",
    );
  const alice = { channel: "@alice", sender: "alice" };

  function sendAlice(mind: Mind, session: string, messageId: string) {
    mind
      .resolve(session)
      .handle([{ type: "text", text: `hello ${messageId}` }], { ...alice, messageId });
  }

  /** A transcript `rotateSession` can seed a rotation from: a few plain exchanges. */
  function plantTranscript(sessionId: string) {
    const dir = resolve(process.env.HOME!, ".claude/projects/rotation-test");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 3; i++) {
      const u = `${sessionId}-u${i}`;
      const a = `${sessionId}-a${i}`;
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: u,
          parentUuid: parent,
          sessionId,
          timestamp: "2026-09-30T12:00:00.000Z",
          message: { role: "user", content: `earlier ${i}` },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: a,
          parentUuid: u,
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] },
        }),
      );
      parent = a;
    }
    writeFileSync(resolve(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  }

  it("a rotation gives the rotated context the instructions again", async () => {
    const session = "ri-rotate";
    control.sessionIds.set(session, "sess-ri-rotate");
    plantTranscript("sess-ri-rotate");
    const mind = newMind({ maxContextTokens: 100 });
    control.turns.set(session, [{ inputTokens: 1000 }]);
    sendAlice(mind, session, "r1");
    await waitFor(() => dones(session).length === 1, "r1's done");
    const archive = resolve(mindDir, ".mind/sessions/archive");
    await waitFor(
      () => existsSync(archive) && readdirSync(archive).some((f) => f.startsWith(`${session}-`)),
      "the rotation to land",
    );
    sendAlice(mind, session, "r2");
    await waitFor(() => dones(session).length === 2, "r2's done");
    assert.equal(replyNotes(session).length, 2, "reminded on each side of the rotation");
  });

  it("a native compaction gives the compacted context the instructions again", async () => {
    // Native compaction is the backstop past the rotation cap: three rotations that each
    // leave the context over the threshold spend it, and the fourth turn's auto-compaction
    // is let through rather than turned into another rotation.
    const session = "ri-compact";
    control.sessionIds.set(session, "sess-ri-compact");
    plantTranscript("sess-ri-compact");
    const mind = newMind({ maxContextTokens: 100 });
    for (const id of ["k1", "k2", "k3"]) {
      control.byPrompt.push({ match: `hello ${id}`, turn: { inputTokens: 1000 } });
    }
    control.byPrompt.push({ match: "hello k4", turn: { compacts: true } });
    const rotations = () =>
      posted.filter(
        (p) =>
          p.body.type === "log" &&
          String(p.body.content).startsWith(`session "${session}": rotated `),
      );
    for (const [i, id] of ["k1", "k2", "k3", "k4", "k5"].entries()) {
      sendAlice(mind, session, id);
      await waitFor(() => dones(session).length === i + 1, `${id}'s done`);
      if (i < 3) await waitFor(() => rotations().length === i + 1, `rotation ${i + 1}`);
    }
    assert.equal(rotations().length, 3, "no rotation after the cap");
    // One reminder per context: the first, one after each rotation, one after compaction.
    assert.equal(replyNotes(session).length, 5);
  });

  it("the event note is given again after a rotation", async () => {
    const session = "ev-rotate";
    control.sessionIds.set(session, "sess-ev-rotate");
    plantTranscript("sess-ev-rotate");
    const mind = newMind({ maxContextTokens: 100 });
    control.turns.set(session, [{ inputTokens: 1000 }]);
    const event = (messageId: string) =>
      mind.resolve(session).handle([{ type: "text", text: `event ${messageId}` }], {
        channel: `event:schedule:${messageId}`,
        isEvent: true,
        messageId,
      });
    event("e1");
    await waitFor(() => dones(session).length === 1, "e1's done");
    const archive = resolve(mindDir, ".mind/sessions/archive");
    await waitFor(
      () => existsSync(archive) && readdirSync(archive).some((f) => f.startsWith(`${session}-`)),
      "the rotation to land",
    );
    event("e2");
    await waitFor(() => dones(session).length === 2, "e2's done");
    const notes = posted.filter(
      (p) =>
        p.path.endsWith("/events") &&
        p.body.session === session &&
        p.body.type === "context" &&
        // claude reports both notes under the hook's name; the event note names no channel.
        p.body.metadata?.source === "reply-instructions" &&
        !/volute chat send/.test(p.body.content),
    );
    assert.equal(notes.length, 2);
  });

  it("a session that starts over after a failed resume is reminded again", async () => {
    const session = "ri-restart";
    const mind = newMind();
    control.turns.set(session, [{}, { throws: true }]);
    sendAlice(mind, session, "s1");
    await waitFor(() => dones(session).length === 1, "s1's done");
    sendAlice(mind, session, "s2");
    await waitFor(() => dones(session).length === 2, "s2's done");
    assert.equal(replyNotes(session).length, 2);
  });
});

describe("claude: an interrupt the SDK refuses folds into the running turn (#1220)", () => {
  it("the refused interrupter is covered by the turn it joined", async () => {
    const session = "intr-refused";
    const mind = newMind();
    const d1 = hold("hello i1");
    send(mind, session, "i1");
    await d1.taken;
    control.rejectInterrupt = true;
    try {
      mind
        .resolve(session)
        .handle([{ type: "text", text: "hello i2" }], { messageId: "i2", interrupt: true });
      // Let the rejection land before the turn ends.
      await new Promise((r) => setImmediate(r));
    } finally {
      control.rejectInterrupt = false;
    }
    d1.release();
    await waitFor(() => dones(session).length >= 1, "i1's done");
    assert.deepEqual(dones(session)[0].body.covers, ["i1", "i2"]);
  });
});

describe("claude: a failed rotation carries only what is still pending (#1220)", () => {
  it("a carried listener can still be unsubscribed", async () => {
    // d1's turn ends over the threshold and its rotation fails (no transcript), so d2 —
    // queued behind it, with a listener — is handed to a fresh session.
    const session = "carry";
    const mind = newMind({ maxContextTokens: 100 });
    control.turns.set(session, [{ inputTokens: 1000 }]);
    const fresh = hold("hello c2");
    send(mind, session, "c1");
    const heard: string[] = [];
    const unsubscribe = mind
      .resolve(session)
      .handle([{ type: "text", text: "hello c2" }], { messageId: "c2" }, (e) => heard.push(e.type));
    await fresh.taken;
    unsubscribe();
    fresh.release();
    await waitFor(() => dones(session).length === 2, "both dones");
    assert.deepEqual(heard, [], "the listener heard nothing once unsubscribed");
  });

  it("carryOver hands over only the given deliveries' channels and listeners", async () => {
    const { carryOver } = await import(resolve(composedDir, "src/lib/recover.ts"));
    const listen = () => () => {};
    const [l1, l2] = [listen(), listen()];
    const from = {
      messageChannels: new Map([
        ["done-1", { channel: "@alice" }],
        ["pending-2", { channel: "@bob" }],
      ]),
      listeners: new Map([
        [l1, "done-1"],
        [l2, "pending-2"],
      ]),
    };
    const to = { messageChannels: new Map(), listeners: new Map() };
    carryOver(from, to, new Set(["pending-2"]));
    assert.deepEqual([...to.messageChannels.keys()], ["pending-2"]);
    assert.deepEqual([...to.listeners.values()], ["pending-2"]);
  });
});
