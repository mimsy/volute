import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  async function* stream() {
    yield { type: "system", subtype: "init", model: "fake-model", session_id: "sess-1" };
    for (;;) {
      const turn = control().turns.get(options.env?.VOLUTE_SESSION)?.shift() ?? {};
      if (turn.end) return;
      const next = await input.next();
      if (next.done) return;
      const text = next.value.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\\n");
      for (const matcher of options.hooks?.UserPromptSubmit ?? []) {
        for (const hook of matcher.hooks) {
          await hook(
            { hook_event_name: "UserPromptSubmit", prompt: text, session_id: "sess-1" },
            undefined,
            { signal: new AbortController().signal },
          );
        }
      }
      if (signal?.aborted) throw aborted();
      if (turn.throws) throw new Error("stream died");
      control().prompts.push({ session: options.env?.VOLUTE_SESSION, text });
      yield {
        type: "assistant",
        session_id: "sess-1",
        message: {
          usage: { input_tokens: turn.inputTokens ?? 10, output_tokens: 1 },
          content: [{ type: "text", text: "ok" }],
        },
      };
      yield { type: "result", subtype: "success", session_id: "sess-1", usage: { input_tokens: 10, output_tokens: 1 } };
      if (signal?.aborted) throw aborted();
    }
  }
  const s = stream();
  s.interrupt = async () => {};
  return s;
}
`;

let composedDir: string;
let mindDir: string;
let captureDir: string;
let server: Server;
const posted: { path: string; body: any }[] = [];
/** Scripted turns, by the session whose stream runs them. */
const control: { turns: Map<string, Turn[]>; prompts: { session: string; text: string }[] } = {
  turns: new Map(),
  prompts: [],
};

type Mind = {
  resolve: (name: string) => {
    handle: (content: unknown[], meta: any, listener?: (e: any) => void) => () => void;
  };
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
});
