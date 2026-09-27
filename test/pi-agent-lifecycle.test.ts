import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * The pi template's session lifecycle, driven end to end through the real composed
 * `agent.ts` against pi-ai's faux provider (#1190): init failure, context-loss notices
 * and their `committed` gate, rotation timing, ephemeral eviction and subagent usage.
 *
 * The composed template lives in a temp dir, so the repo's node_modules is linked in,
 * entry by entry, for its bare imports to resolve (to the same module instances this
 * file imports). The one gap: the template depends on `@sinclair/typebox`, which the
 * repo doesn't install; pi's own `typebox` has the same `Type.Object`/`Type.String`.
 * daemon-client reads the daemon port at module load, so the capture server and env
 * come first, then the dynamic import.
 */

type Captured = {
  path: string;
  type?: string;
  kind?: string;
  message?: string;
  thread?: string;
  session?: string;
  content?: string;
  messageId?: string;
  metadata?: Record<string, any>;
};

const repoRoot = resolvePath(fileURLToPath(import.meta.url), "../..");
let composedDir: string;
let server: Server;
let captured: Captured[] = [];
let createMind: typeof import("../templates/pi/src/agent.js")["createMind"];
let faux: any;
let fauxAssistantMessage: any;
let modelRuntime: any;
const scratch: string[] = [];

function events(type: string, session?: string) {
  return captured.filter(
    (e) => e.path === "events" && e.type === type && (!session || e.session === session),
  );
}
function notices() {
  return captured.filter((e) => e.path === "notices");
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}; captured=${JSON.stringify(captured)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fresh mind layout: `<dir>/home` (cwd) and `<dir>/.mind/pi-sessions`. */
function makeMindDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
  scratch.push(dir);
  const cwd = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  return { dir, cwd, sessionsDir: join(dir, ".mind", "pi-sessions") };
}

async function newMind(
  layout: ReturnType<typeof makeMindDir>,
  extra: Partial<Parameters<typeof createMind>[0]> = {},
) {
  return createMind({
    systemPrompt: "You are a test mind.",
    cwd: layout.cwd,
    mindDir: layout.dir,
    sessionsDir: layout.sessionsDir,
    model: "faux:faux-1",
    modelRuntime,
    ...extra,
  });
}

let msgSeq = 0;
function send(
  mind: Awaited<ReturnType<typeof newMind>>,
  session: string,
  text: string,
  listener?: (e: any) => void,
) {
  const messageId = `m${++msgSeq}`;
  mind.resolve(session).handle([{ type: "text", text }], { messageId } as any, listener);
  return messageId;
}

/** A pi transcript line set: header + one user/assistant exchange. */
function transcript(cwd: string, id: string, extra: object[] = []) {
  const ts = "2026-09-01T10:00:00.000Z";
  const lines: object[] = [
    { type: "session", version: 3, id, timestamp: ts, cwd },
    {
      type: "message",
      id: `${id}-u`,
      parentId: null,
      timestamp: ts,
      message: { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 },
    },
    {
      type: "message",
      id: `${id}-a`,
      parentId: `${id}-u`,
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
    ...extra,
  ];
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

before(async () => {
  composedDir = composeTemplate(resolvePath(repoRoot, "templates"), "pi").composedDir;
  const rootModules = resolvePath(repoRoot, "node_modules");
  const modules = resolvePath(composedDir, "node_modules");
  mkdirSync(join(modules, "@sinclair"), { recursive: true });
  for (const entry of readdirSync(rootModules)) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    symlinkSync(join(rootModules, entry), join(modules, entry));
  }
  symlinkSync(join(rootModules, "typebox"), join(modules, "@sinclair", "typebox"));

  await new Promise<void>((r) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const path = req.url?.endsWith("/events")
          ? "events"
          : req.url?.endsWith("/notices")
            ? "notices"
            : "other";
        try {
          captured.push({ path, ...JSON.parse(body) });
        } catch {
          // ignore malformed
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", r);
  });
  process.env.VOLUTE_DAEMON_PORT = String((server.address() as { port: number }).port);
  process.env.VOLUTE_MIND = "test-mind";
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
  scratch.push(process.env.PI_CODING_AGENT_DIR);
  process.env.PI_OFFLINE = "1";

  const piAi = await import("@earendil-works/pi-ai");
  const pca = await import("@earendil-works/pi-coding-agent");
  fauxAssistantMessage = piAi.fauxAssistantMessage;
  faux = piAi.fauxProvider();
  modelRuntime = await pca.ModelRuntime.create();
  modelRuntime.registerNativeProvider(faux.provider);

  ({ createMind } = await import(resolvePath(composedDir, "src/agent.js")));
});

after(() => {
  server?.close();
  // rm unlinks the node_modules symlinks rather than following them.
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  delete process.env.VOLUTE_DAEMON_PORT;
  delete process.env.VOLUTE_MIND;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_OFFLINE;
});

beforeEach(() => {
  captured = [];
  faux.setResponses([]);
});

describe("pi session init failure", () => {
  it("fails the waiting turn to the daemon and gives the next message a fresh session", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    // A file where the sessions directory should be: the SessionManager can't create
    // the thread's dir under it (ENOTDIR), so init fails whatever is tried.
    mkdirSync(join(layout.dir, ".mind"), { recursive: true });
    writeFileSync(layout.sessionsDir, "not a directory");

    send(mind, "main", "hello?");
    await waitFor(() => events("done", "main").length > 0, "done for the failed turn");
    assert.equal(events("error", "main").length, 1, "the failure reaches the daemon");
    const errIdx = captured.findIndex((e) => e.type === "error");
    const doneIdx = captured.findIndex((e) => e.type === "done");
    assert.ok(errIdx < doneIdx, "error before done, so the daemon flags the turn errored");
    assert.deepEqual((await mind.getContextInfo()).sessions, [], "the dead session is evicted");

    // The obstacle goes away: the thread is not deaf for the life of the process.
    rmSync(layout.sessionsDir);
    captured = [];
    faux.setResponses([fauxAssistantMessage("I'm here")]);
    send(mind, "main", "hello again");
    await waitFor(() => events("done", "main").length > 0, "done for the retried turn");
    assert.equal(events("error").length, 0);
    assert.ok(events("text", "main").some((e) => e.content === "I'm here"));
  });

  it("starts fresh past a transcript that can't be resumed, and says the context was lost", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    // A message entry pi can't rebuild context from — createAgentSession throws on it.
    const bad = { type: "message", id: "bad", parentId: "s1-a", timestamp: "x", message: null };
    writeFileSync(join(dir, "old.jsonl"), transcript(layout.cwd, "s1", [bad]));
    writeFileSync(join(dir, ".committed"), "");
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("fresh start")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    assert.equal(events("error").length, 0, "the fresh session answered");
    const lost = notices();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].kind, "context_lost");
    assert.equal(lost[0].thread, undefined, "mind-level, so it can't strand (#768)");
    assert.match(lost[0].message ?? "", /`main` thread couldn't be resumed/);
    // The fresh session's first turn is real conversation again.
    await waitFor(() => existsSync(join(dir, ".committed")), "marker re-set after the turn");
  });

  it("stays quiet about a resume failure when the thread was never known to hold anything", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    const bad = { type: "message", id: "bad", parentId: "s1-a", timestamp: "x", message: null };
    writeFileSync(join(dir, "old.jsonl"), transcript(layout.cwd, "s1", [bad]));
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("fresh start")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    assert.equal(notices().length, 0);
  });
});

describe("pi context_lost on a missing transcript", () => {
  it("tells the mind when a committed thread finds nothing to resume (e.g. home moved)", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    // Written under a different home path: continueRecent matches by header cwd.
    writeFileSync(join(dir, "old.jsonl"), transcript("/somewhere/else/home", "s1"));
    writeFileSync(join(dir, ".committed"), "");
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("hello")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    const lost = notices();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].kind, "context_lost");
    assert.match(lost[0].message ?? "", /previous session for the `main` thread/);
  });

  it("says nothing when the same thread was never committed (#769)", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), transcript("/somewhere/else/home", "s1"));
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("hello")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    assert.equal(notices().length, 0);
  });

  it("says nothing on an ordinary resume, and marks it committed", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), transcript(layout.cwd, "s1"));
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("welcome back")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    assert.equal(notices().length, 0);
    assert.ok(existsSync(join(dir, ".committed")), "a resumed transcript is real conversation");
  });

  it("marks a brand-new thread committed once a turn has landed", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    faux.setResponses([fauxAssistantMessage("first words")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    await waitFor(
      () => existsSync(join(layout.sessionsDir, "main", ".committed")),
      "marker after first turn",
    );
    assert.equal(notices().length, 0);
  });
});

describe("pi rotation", () => {
  it("rotates only once the run has settled, never under a follow-up still streaming", async () => {
    const layout = makeMindDir();
    const archive = join(layout.sessionsDir, "archive");
    const mind = await newMind(layout, { maxContextTokens: 50 });

    let archivedDuringFollowUp: boolean | undefined;
    faux.setResponses([
      fauxAssistantMessage("first"),
      async () => {
        // The follow-up's model call: the turn before it crossed the threshold, but the
        // run hasn't settled, so the session file must not have been swapped yet.
        await new Promise((r) => setTimeout(r, 150));
        archivedDuringFollowUp = existsSync(archive);
        return fauxAssistantMessage("second");
      },
    ]);
    let followUpSent = false;
    send(mind, "main", "one", (e) => {
      // The local done fires at agent_end, like the daemon's — the moment a real
      // follow-up can arrive while pi is still finishing the run.
      if (e.type === "done" && !followUpSent) {
        followUpSent = true;
        send(mind, "main", "two");
      }
    });
    await waitFor(() => archivedDuringFollowUp !== undefined, "follow-up model call");
    assert.equal(archivedDuringFollowUp, false, "rotation waited for the run to settle");
    await waitFor(() => existsSync(archive), "rotation after settle");

    // The next turn is told about the rotation.
    faux.setResponses([fauxAssistantMessage("third")]);
    send(mind, "main", "three");
    await waitFor(
      () =>
        events("context", "main").some(
          (e) =>
            e.metadata?.source === "seeded-session" &&
            /consolidated at the context limit/.test(e.content ?? ""),
        ),
      "rotation note on the next turn",
    );
    assert.equal(notices().length, 0, "a successful rotation is not a loss");
  });
});

describe("pi rotation failure", () => {
  it("falls back to a fresh session and tells the mind the context was lost", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    const mind = await newMind(layout, { maxContextTokens: 50 });
    faux.setResponses([fauxAssistantMessage("over the limit")]);
    let blocked = false;
    send(mind, "main", "one", (e) => {
      // At agent_end, before the run settles and rotates: make the transcript unreadable
      // (pi only appends to it), so building the rotated tail fails.
      if (e.type === "done" && !blocked) {
        blocked = true;
        for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) chmodSync(join(dir, f), 0o200);
      }
    });
    await waitFor(() => notices().length > 0, "rotation-failure notice");
    const lost = notices();
    assert.equal(lost[0].kind, "context_lost");
    assert.equal(lost[0].thread, undefined);
    assert.match(lost[0].message ?? "", /rotation failed .* the `main` thread was reset/);
    assert.ok(!existsSync(join(dir, ".committed")), "the fresh session holds nothing yet");
  });
});

describe("pi seeded note", () => {
  it("is offered on the first turn after a seed and cleared once that turn settles", async () => {
    const layout = makeMindDir();
    const archived = join(layout.sessionsDir, "archive", "main-2026-09-01T10-00");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "old.jsonl"), transcript("/old/home", "s0"));
    const mind = await newMind(layout);

    faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    send(mind, "main", "one");
    await waitFor(() => events("done", "main").length === 1, "first done");
    const seededNotes = () =>
      events("context", "main").filter((e) => e.metadata?.source === "seeded-session");
    assert.equal(seededNotes().length, 1);
    send(mind, "main", "two");
    await waitFor(() => events("done", "main").length === 2, "second done");
    assert.equal(seededNotes().length, 1, "not repeated once a turn has settled");
  });
});

describe("pi ephemeral sessions", () => {
  it("evicts a new-* session once its turn is done", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    faux.setResponses([fauxAssistantMessage("one-off")]);
    send(mind, "new-123-abc", "hi");
    await waitFor(() => events("done", "new-123-abc").length > 0, "done");
    // Let the dispatch's finally run.
    await new Promise((r) => setTimeout(r, 50));
    const names = (await mind.getContextInfo()).sessions.map((s) => s.name);
    assert.deepEqual(names, []);
  });

  it("keeps a persistent session", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    faux.setResponses([fauxAssistantMessage("still here")]);
    send(mind, "main", "hi");
    await waitFor(() => events("done", "main").length > 0, "done");
    await new Promise((r) => setTimeout(r, 50));
    const names = (await mind.getContextInfo()).sessions.map((s) => s.name);
    assert.deepEqual(names, ["main"]);
  });
});

describe("pi subagent usage", () => {
  it("counts a subagent's tokens in the parent turn's usage", async () => {
    const layout = makeMindDir();
    writeFileSync(join(layout.cwd, "helper.md"), "You help.");
    const mind = await newMind(layout, {
      subagents: { helper: { description: "helps", systemPrompt: "helper.md" } },
    });
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("helper", { prompt: "do the thing" })),
      fauxAssistantMessage("did the thing, at length, with many words to count"),
      fauxAssistantMessage("done"),
    ]);
    send(mind, "main", "use your helper");
    await waitFor(() => events("done", "main").length > 0, "done");
    const usage = events("usage", "main");
    assert.equal(usage.length, 1);
    const m = usage[0].metadata!;
    assert.equal(m.main_model, "faux:faux-1");
    assert.ok(Array.isArray(m.models), "a per-model breakdown");
    const slice = m.models.find((s: any) => s.model === "faux:faux-1");
    assert.ok(slice, "same model: the subagent is merged into the main slice");
    assert.ok(
      slice.output_tokens > m.output_tokens,
      `the slice counts the subagent's output too (${slice.output_tokens} > ${m.output_tokens})`,
    );
  });

  it("sends a plain usage event when no subagent ran, per run not cumulative", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    faux.setResponses([fauxAssistantMessage("same"), fauxAssistantMessage("same")]);
    send(mind, "main", "one");
    await waitFor(() => events("done", "main").length === 1, "first done");
    send(mind, "main", "two");
    await waitFor(() => events("done", "main").length === 2, "second done");
    const [u1, u2] = events("usage", "main").map((e) => e.metadata!);
    assert.equal(u1.models, undefined);
    assert.equal(u1.main_model, undefined);
    assert.equal(u2.output_tokens, u1.output_tokens, "the second turn doesn't re-count the first");
  });
});

describe("pi shutdown", () => {
  it("commits a cut-short turn's edits on shutdown, like claude", () => {
    // Source-level: exercising it would mean signalling a live server process.
    const server = readFileSync(resolvePath(repoRoot, "templates/pi/src/server.ts"), "utf-8");
    const shutdown = server.split("setupShutdown(")[1] ?? "";
    assert.match(shutdown, /flushFileChanges\(/);
  });
});
