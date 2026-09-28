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
 * file imports).
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
let pca: any;
let createEventHandler: typeof import("../templates/pi/src/lib/event-handler.js")["createEventHandler"];
const scratch: string[] = [];
/** chmod can't make a file unreadable to root; tests that fail a read that way skip there. */
const asRoot = process.getuid?.() === 0;
/** What the fake daemon answers a recollection request with (null → no entries field). */
let recollection: { entries: object[] | null; delayMs: number } = { entries: null, delayMs: 0 };
/** Recollection requests the fake daemon hasn't answered yet — a rotation in progress. */
let recollectionInFlight = 0;

function events(type: string, session?: string) {
  return captured.filter(
    (e) => e.path === "events" && e.type === type && (!session || e.session === session),
  );
}
/** The daemon has heard this message's turn end — immune to a late event from an earlier test's mind. */
function doneFor(messageId: string) {
  return captured.some(
    (e) => e.path === "events" && e.type === "done" && e.messageId === messageId,
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
    loadSystemPrompt: () => "You are a test mind.",
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
  mkdirSync(modules, { recursive: true });
  for (const entry of readdirSync(rootModules)) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    symlinkSync(join(rootModules, entry), join(modules, entry));
  }

  await new Promise<void>((r) => {
    server = createServer((req, res) => {
      if (req.url?.includes("/history/recollection")) {
        captured.push({ path: "recollection" });
        const { entries, delayMs } = recollection;
        recollectionInFlight++;
        setTimeout(() => {
          recollectionInFlight--;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(entries ? { entries } : {}));
        }, delayMs);
        return;
      }
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
  pca = await import("@earendil-works/pi-coding-agent");
  fauxAssistantMessage = piAi.fauxAssistantMessage;
  faux = piAi.fauxProvider();
  modelRuntime = await pca.ModelRuntime.create();
  modelRuntime.registerNativeProvider(faux.provider);

  ({ createMind } = await import(resolvePath(composedDir, "src/agent.js")));
  ({ createEventHandler } = await import(resolvePath(composedDir, "src/lib/event-handler.js")));
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
  recollection = { entries: null, delayMs: 0 };
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
    assert.match(lost[0].message ?? "", /^The `main` thread couldn't be resumed/);
    // The fresh session's first turn is real conversation again.
    await waitFor(() => existsSync(join(dir, ".committed")), "marker re-set after the turn");
  });

  it("starts fresh when the transcript can't even be opened", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), transcript(layout.cwd, "s1"));
    writeFileSync(join(dir, ".committed"), "");
    const mind = await newMind(layout);

    // continueRecent reads and parses the newest transcript; make that throw once, as
    // an unreadable or unparseable file does.
    const continueRecent = pca.SessionManager.continueRecent;
    let failed = false;
    pca.SessionManager.continueRecent = (...args: any[]) => {
      if (!failed) {
        failed = true;
        throw new Error("Session file is not a valid session");
      }
      return continueRecent.apply(pca.SessionManager, args);
    };
    try {
      faux.setResponses([fauxAssistantMessage("fresh start")]);
      send(mind, "main", "hi");
      await waitFor(() => events("done", "main").length > 0, "done");
      assert.equal(events("error").length, 0, "the fresh session answered");
      assert.equal(notices().length, 1);
      assert.match(notices()[0].message ?? "", /couldn't be resumed/);
    } finally {
      pca.SessionManager.continueRecent = continueRecent;
    }
  });

  it("keeps an intact transcript through a failure that isn't the transcript's", async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), transcript(layout.cwd, "s1"));
    writeFileSync(join(dir, ".committed"), "");
    const mind = await newMind(layout);

    // A transient failure after the transcript opened cleanly (resource loading here).
    const reload = pca.DefaultResourceLoader.prototype.reload;
    let failed = false;
    pca.DefaultResourceLoader.prototype.reload = async function (this: unknown, ...args: any[]) {
      if (!failed) {
        failed = true;
        throw new Error("transient");
      }
      return reload.apply(this, args);
    };
    try {
      send(mind, "main", "hi");
      await waitFor(() => events("done", "main").length > 0, "done for the failed turn");
      assert.equal(events("error", "main").length, 1);
      assert.equal(notices().length, 0, "nothing was lost, so the mind isn't told it was");

      captured = [];
      faux.setResponses([
        (context: any) => {
          // The next message resumes the same conversation.
          const said = JSON.stringify(context.messages);
          return fauxAssistantMessage(said.includes("earlier reply") ? "remembered" : "forgot");
        },
      ]);
      send(mind, "main", "again");
      await waitFor(() => events("done", "main").length > 0, "done for the next turn");
      assert.ok(events("text", "main").some((e) => e.content === "remembered"));
      assert.equal(notices().length, 0);
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.endsWith(".jsonl")),
        ["old.jsonl"],
        "no fresh transcript was started",
      );
    } finally {
      pca.DefaultResourceLoader.prototype.reload = reload;
    }
  });

  it("tells the mind when a seeded tail can't be resumed, marker or not", async () => {
    const layout = makeMindDir();
    const archived = join(layout.sessionsDir, "archive", "main-2026-09-01T10-00");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "old.jsonl"), transcript("/old/home", "s0"));
    const mind = await newMind(layout);

    const build = pca.SessionManager.prototype.buildSessionContext;
    let failed = false;
    pca.SessionManager.prototype.buildSessionContext = function (this: unknown, ...args: any[]) {
      if (!failed) {
        failed = true;
        throw new Error("unreadable seed");
      }
      return build.apply(this, args);
    };
    try {
      faux.setResponses([fauxAssistantMessage("fresh")]);
      send(mind, "main", "hi");
      await waitFor(() => events("done", "main").length > 0, "done");
      const lost = notices();
      assert.equal(lost.length, 1, "the restored conversation was real, and it's gone");
      assert.match(lost[0].message ?? "", /couldn't be resumed/);
      assert.equal(
        events("context", "main").filter((e) => e.metadata?.source === "seeded-session").length,
        0,
        "no restored-session note for a conversation that didn't continue",
      );
    } finally {
      pca.SessionManager.prototype.buildSessionContext = build;
    }
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
  it("a message sent at `done` waits out the settle and runs on the rotated session", async () => {
    const layout = makeMindDir();
    const archive = join(layout.sessionsDir, "archive");
    const mind = await newMind(layout, { maxContextTokens: 50 });

    let rotatedBeforeFollowUp: boolean | undefined;
    let followUpContext = "";
    faux.setResponses([
      fauxAssistantMessage("first"),
      (context: { messages: unknown[] }) => {
        // The follow-up's model call. The daemon sent it at `done` (agent_end), while the
        // run was still winding down: it must not ride into that run, nor start under the
        // rotation — it runs once the session has rotated.
        rotatedBeforeFollowUp = existsSync(archive);
        followUpContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("second");
      },
    ]);
    let followUpSent = false;
    let two = "";
    send(mind, "main", "one", (e) => {
      // The local done fires at agent_end, like the daemon's — the moment a real
      // follow-up can arrive while pi is still finishing the run.
      if (e.type === "done" && !followUpSent) {
        followUpSent = true;
        two = send(mind, "main", "two");
      }
    });
    await waitFor(() => rotatedBeforeFollowUp !== undefined, "follow-up model call");
    assert.equal(rotatedBeforeFollowUp, true, "the follow-up waited for the rotation");
    assert.match(followUpContext, /consolidated at the context limit/, "and is told of it");
    await waitFor(() => doneFor(two), "follow-up done");
    assert.equal(notices().length, 0, "a successful rotation is not a loss");
  });
});

describe("pi rotation failure", () => {
  it("falls back to a fresh session and tells the mind the context was lost", {
    skip: asRoot && "chmod can't block root's read",
  }, async () => {
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

describe("pi failed dispatch", () => {
  it("delivers a failed message's done to its own listener while another turn is current", async () => {
    const layout = makeMindDir();
    const mind = await newMind(layout);
    const prompt = pca.AgentSession.prototype.prompt;
    pca.AgentSession.prototype.prompt = function (this: unknown, text: string, ...rest: any[]) {
      if (text === "fail-me") return Promise.reject(new Error("queue refused"));
      return prompt.call(this, text, ...rest);
    };
    try {
      let bDone = false;
      let b = "";
      faux.setResponses([
        async () => {
          // Turn A is current while B arrives and fails.
          b = send(mind, "main", "fail-me", (e) => {
            if (e.type === "done") bDone = true;
          });
          await waitFor(() => bDone, "B's done at B's listener");
          return fauxAssistantMessage("A done");
        },
      ]);
      const a = send(mind, "main", "A");
      await waitFor(() => events("done", "main").length >= 2, "both turns done");
      assert.ok(bDone);
      // B's done retires B and ends no turn — A is still running beside it; A's own done
      // names A (#1207).
      const [bEnd, aEnd] = events("done", "main") as (Captured & { covers?: string[] })[];
      assert.deepEqual(bEnd.covers, [b]);
      assert.equal(bEnd.messageId, undefined);
      assert.equal(aEnd.messageId, a);
      assert.ok(aEnd.covers?.includes(a));
      assert.ok(!aEnd.covers?.includes(b), "B never reached pi's queue");
      const bError = events("error", "main").find((e) => e.messageId === b);
      assert.ok(bError, "B's error names B, not the turn running beside it");
    } finally {
      pca.AgentSession.prototype.prompt = prompt;
    }
  });
});

describe("pi usage breakdown", () => {
  it("always names a main slice, even at zero usage, so subagent slices are priced", async () => {
    const session = {
      name: "main",
      messageIds: ["m1"] as (string | undefined)[],
      messageChannels: new Map([["m1", { channel: "#test" }]]),
      subagentUsage: [
        {
          model: "other:sub-1",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    };
    const handler = createEventHandler(session as never, {
      cwd: makeMindDir().cwd,
      broadcast: () => {},
      mainModel: "faux:faux-1",
    });
    handler({ type: "agent_start" } as never);
    handler({ type: "agent_end", messages: [] } as never);
    await waitFor(() => events("done", "main").length > 0, "done");
    const [usage] = events("usage", "main");
    assert.equal(usage.metadata!.main_model, "faux:faux-1");
    assert.deepEqual(
      usage.metadata!.models.map((s: any) => s.model),
      ["faux:faux-1", "other:sub-1"],
    );
    // The turn's channel survives into its done (it used to be read after its deletion).
    assert.equal((events("done", "main")[0] as any).channel, "#test");
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

  it("never restarts the mind on an identity edit", () => {
    for (const file of ["agent.ts", "server.ts", "lib/event-handler.ts"]) {
      const src = readFileSync(resolvePath(repoRoot, "templates/pi/src", file), "utf-8");
      assert.doesNotMatch(src, /daemonRestart|onIdentityReload/, `${file} restarts the mind`);
    }
  });
});

describe("pi post-tool-use hook stdin", () => {
  it("hands a mind's hook claude's envelope: claude tool names, tool_response, session", async () => {
    const layout = makeMindDir();
    const hookDir = join(layout.cwd, ".local", "hooks", "post-tool-use");
    mkdirSync(hookDir, { recursive: true });
    const out = join(layout.dir, "stdin.json");
    writeFileSync(
      join(hookDir, "record.sh"),
      `#!/bin/bash\ncat > ${JSON.stringify(out)}\necho '{}'\n`,
    );
    chmodSync(join(hookDir, "record.sh"), 0o755);
    const mind = await newMind(layout);
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "call-1" })),
      fauxAssistantMessage("done"),
    ]);
    const id1 = send(mind, "main", "run something");
    await waitFor(() => doneFor(id1), "hook ran");
    await waitFor(() => readFileSync(out, "utf-8").length > 0, "hook stdin written");
    const input = JSON.parse(readFileSync(out, "utf-8"));
    assert.equal(input.hook_event_name, "PostToolUse");
    assert.equal(input.tool_name, "Bash", "pi's `bash` reaches the hook as claude's `Bash`");
    assert.deepEqual(input.tool_input, { command: "echo hi" });
    assert.equal(input.tool_use_id, "call-1");
    assert.equal(input.session, "main");
    assert.equal(input.cwd, layout.cwd);
    assert.equal(typeof input.session_id, "string");
    assert.match(input.transcript_path, /\.jsonl$/);
    assert.deepEqual(
      input.tool_response,
      { stdout: "hi\n", stderr: "", exit_code: 0, interrupted: false },
      "bash's response in claude's shape",
    );
  });
});

const RECALL = [
  {
    period: "day",
    period_key: "2026-08-30",
    start: "2026-08-30T00:00:00.000Z",
    end: "2026-08-31T00:00:00.000Z",
    content: "I rewrote the pond poem twice.",
    author: "mind",
  },
];

describe("pi recollection at seams", () => {
  it("a woken thread gets its recollection ahead of the tail, and the note says so", async () => {
    const layout = makeMindDir();
    const archived = join(layout.sessionsDir, "archive", "main-2026-09-01T10-00");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "old.jsonl"), transcript("/old/home", "s0"));
    recollection = { entries: RECALL, delayMs: 0 };
    const mind = await newMind(layout);

    let seen = "";
    faux.setResponses([
      (context: { messages: unknown[] }) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage("awake");
      },
    ]);
    const id2 = send(mind, "main", "good morning");
    await waitFor(() => doneFor(id2), "done");
    assert.ok(
      captured.some((e) => e.path === "recollection"),
      "the daemon was asked",
    );
    const recallAt = seen.indexOf("pond poem");
    assert.ok(recallAt >= 0, "the model sees the recollection");
    assert.ok(recallAt < seen.indexOf("earlier reply"), "ahead of the verbatim tail");
    const note = events("context", "main").find((e) => e.metadata?.source === "seeded-session");
    assert.match(note?.content ?? "", /consolidated memory of the days before/);
  });

  it("recollection disabled seeds the tail alone and never asks the daemon", async () => {
    const layout = makeMindDir();
    const archived = join(layout.sessionsDir, "archive", "main-2026-09-01T10-00");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "old.jsonl"), transcript("/old/home", "s0"));
    recollection = { entries: RECALL, delayMs: 0 };
    const mind = await newMind(layout, { recollection: false });
    faux.setResponses([fauxAssistantMessage("awake")]);
    const id3 = send(mind, "main", "good morning");
    await waitFor(() => doneFor(id3), "done");
    assert.ok(!captured.some((e) => e.path === "recollection"));
    const note = events("context", "main").find((e) => e.metadata?.source === "seeded-session");
    assert.ok(note, "still seeded");
    assert.doesNotMatch(note?.content ?? "", /consolidated memory/, "no claim of recollection");
  });

  it("rotation carries recollection, and a message sent during the fetch lands after it", async () => {
    const layout = makeMindDir();
    const archive = join(layout.sessionsDir, "archive");
    recollection = { entries: RECALL, delayMs: 300 };
    // Big enough that a quarter of it (the recollection cap) holds the entry.
    const mind = await newMind(layout, { maxContextTokens: 1000 });

    let seen = "";
    let archivedText = "";
    faux.setResponses([
      fauxAssistantMessage("x".repeat(4000)),
      (context: { messages: unknown[] }) => {
        seen = JSON.stringify(context.messages);
        for (const d of readdirSync(archive))
          for (const f of readdirSync(join(archive, d)))
            archivedText += readFileSync(join(archive, d, f), "utf-8");
        return fauxAssistantMessage("second");
      },
    ]);
    send(mind, "main", "one");
    await waitFor(() => captured.some((e) => e.path === "recollection"), "rotation fetch");
    // Mid-fetch: the session must stay quiet — this message may not reach the transcript
    // being rotated away, nor start a run on it.
    const two = send(mind, "main", "two during the fetch");
    await waitFor(() => seen !== "", "the second turn's model call");

    assert.ok(seen.includes("pond poem"), "the rotated session carries recollection");
    assert.ok(
      seen.indexOf("pond poem") < seen.indexOf("two during the fetch"),
      "the message sent mid-fetch runs on the rotated session, after the seed",
    );
    assert.ok(archivedText.includes('"one"'), "the rotated-away transcript was archived");
    assert.ok(!archivedText.includes("two during"), "and never took the mid-fetch message");
    await waitFor(() => doneFor(two), "second done");
    const note = events("context", "main").find(
      (e) =>
        e.metadata?.source === "seeded-session" &&
        /consolidated at the context limit/.test(e.content ?? ""),
    );
    assert.match(note?.content ?? "", /consolidated memory of the days before/);
  });

  it("an ephemeral thread isn't evicted while it settles, so a message sent then is answered", async () => {
    const layout = makeMindDir();
    recollection = { entries: RECALL, delayMs: 300 };
    const mind = await newMind(layout, { maxContextTokens: 50 });
    faux.setResponses([fauxAssistantMessage("over the limit"), fauxAssistantMessage("still here")]);
    send(mind, "new-1-abc", "one");
    await waitFor(() => captured.some((e) => e.path === "recollection"), "rotation fetch");
    send(mind, "new-1-abc", "two");
    await waitFor(
      () => events("text", "new-1-abc").some((e) => e.content === "still here"),
      "the second message's answer",
    );
  });
});

describe("pi messages that arrive while a rotation fetches recollection", () => {
  it("no second message's run starts while the first's rotation is under way", async () => {
    const layout = makeMindDir();
    // B's pre-run is slow (a pre-prompt hook), so without a gate it would finish inside
    // A's rotation and start a run of its own on the transcript being rotated away.
    const hookDir = join(layout.cwd, ".local", "hooks", "pre-prompt");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(
      join(hookDir, "slow.sh"),
      "#!/bin/bash\ninput=$(cat)\ncase \"$input\" in *slowpoke*) sleep 0.4;; esac\necho '{}'\n",
    );
    chmodSync(join(hookDir, "slow.sh"), 0o755);
    // An earlier test's mind may still be rotating; only this mind's fetches may count.
    await waitFor(() => recollectionInFlight === 0, "earlier rotations to finish", 3000);
    recollection = { entries: RECALL, delayMs: 800 };
    const mind = await newMind(layout, { maxContextTokens: 50 });
    const callsDuringRotation: string[] = [];
    const answer = (text: string) => (context: { messages: unknown[] }) => {
      if (recollectionInFlight > 0) callsDuringRotation.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(text);
    };
    faux.setResponses([answer("a"), answer("b"), answer("c")]);
    const a = send(mind, "main", "A");
    send(mind, "main", "slowpoke B");
    // B may ride A's run as a follow-up (one done for the run) or run after it.
    await waitFor(
      () => doneFor(a) && events("text", "main").some((e) => e.content?.includes("b")),
      "both answered",
      8000,
    );
    await waitFor(() => recollectionInFlight === 0, "rotation finished", 3000);
    assert.deepEqual(callsDuringRotation, [], "nothing ran while the session was rotating");
  });

  it("each fails or succeeds on its own turn — one failure never swallows the next", async () => {
    const layout = makeMindDir();
    recollection = { entries: RECALL, delayMs: 300 };
    const mind = await newMind(layout, { maxContextTokens: 50 });
    const prompt = pca.AgentSession.prototype.prompt;
    // B fails when it actually runs (not while pi would only defer it) — as a provider
    // preflight or auth failure would.
    pca.AgentSession.prototype.prompt = function (this: any, text: string, ...rest: any[]) {
      if (text === "B" && !this._isEmittingAgentSettled) {
        return Promise.reject(new Error("B refused"));
      }
      return prompt.call(this, text, ...rest);
    };
    try {
      faux.setResponses([fauxAssistantMessage("A answered"), fauxAssistantMessage("C answered")]);
      let bDone = false;
      send(mind, "main", "A");
      await waitFor(() => captured.some((e) => e.path === "recollection"), "rotation fetch");
      send(mind, "main", "B", (e) => {
        if (e.type === "done") bDone = true;
      });
      send(mind, "main", "C");
      await waitFor(
        () => events("text", "main").some((e) => e.content === "C answered"),
        "C is answered",
      );
      await waitFor(() => bDone, "B's own done");
      assert.equal(events("error", "main").length, 1, "one failure, B's, reported once");
      assert.match(events("error", "main")[0].content ?? "", /B refused/);
    } finally {
      pca.AgentSession.prototype.prompt = prompt;
    }
  });
});

describe("pi post-tool-use input for file tools", () => {
  it("adds claude's absolute file_path beside pi's path", async () => {
    const { postToolUseInput } = await import(
      resolvePath(composedDir, "src/lib/post-tool-use-input.js")
    );
    const input = postToolUseInput({
      session: "main",
      cwd: "/home/mind",
      toolName: "edit",
      toolCallId: "c1",
      toolInput: { path: "notes/a.md", edits: [] },
      toolResponse: {},
    });
    assert.equal(input.tool_name, "Edit");
    assert.deepEqual(input.tool_input, {
      path: "notes/a.md",
      edits: [],
      file_path: "/home/mind/notes/a.md",
    });
    const bash = postToolUseInput({
      session: "main",
      cwd: "/home/mind",
      toolName: "bash",
      toolCallId: "c2",
      toolInput: { command: "ls", path: "x" },
      toolResponse: {},
    });
    assert.deepEqual(bash.tool_input, { command: "ls", path: "x" }, "only file tools get one");
    assert.deepEqual(input.tool_response, { filePath: "/home/mind/notes/a.md" });
  });

  it("never runs for a call that failed", async () => {
    const layout = makeMindDir();
    const hookDir = join(layout.cwd, ".local", "hooks", "post-tool-use");
    mkdirSync(hookDir, { recursive: true });
    const out = join(layout.dir, "calls.log");
    writeFileSync(
      join(hookDir, "record.sh"),
      `#!/bin/bash
cat >> ${JSON.stringify(out)}
echo >> ${JSON.stringify(out)}
echo '{}'
`,
    );
    chmodSync(join(hookDir, "record.sh"), 0o755);
    const mind = await newMind(layout);
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "exit 3" })),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo ok" })),
      fauxAssistantMessage("done"),
    ]);
    const id = send(mind, "main", "try things");
    await waitFor(() => doneFor(id), "done");
    await waitFor(() => existsSync(out), "the successful call's hook");
    const calls = readFileSync(out, "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "only the call that succeeded");
    assert.equal(JSON.parse(calls[0]).tool_input.command, "echo ok");
  });
});

describe("pi startup context per session (#1199)", () => {
  it("runs fresh for each session and again when it rotates, naming the seam", async () => {
    const layout = makeMindDir();
    const hooks = join(layout.cwd, ".local", "hooks");
    mkdirSync(hooks, { recursive: true });
    // Echoes back the source it was run with, as the shipped hook does in its header line.
    writeFileSync(
      join(hooks, "startup-context.sh"),
      `#!/bin/bash\nsrc=$(cat | sed -n 's/.*"source":"\\([a-z]*\\)".*/\\1/p')\n` +
        `echo "$src" >> ${JSON.stringify(join(layout.dir, "runs.log"))}\n` +
        `echo "{\\"hookSpecificOutput\\":{\\"additionalContext\\":\\"orientation ($src) $VOLUTE_SESSION\\"}}"\n`,
    );
    chmodSync(join(hooks, "startup-context.sh"), 0o755);
    // Not chdir'd: the agent names the mind dir itself, so this runs from elsewhere.
    {
      const mind = await newMind(layout, { maxContextTokens: 50 });
      const startup = () =>
        events("context", "main")
          .filter((e) => e.metadata?.source === "startup-context")
          .map((e) => e.content);

      faux.setResponses([fauxAssistantMessage("over the limit")]);
      const one = send(mind, "main", "one");
      await waitFor(() => doneFor(one), "first done");
      assert.deepEqual(startup(), ["orientation (startup) main"]);
      await waitFor(() => existsSync(join(layout.sessionsDir, "archive")), "rotation");
      await new Promise((r) => setTimeout(r, 200));
      const runs = () => readFileSync(join(layout.dir, "runs.log"), "utf-8").trim().split("\n");
      assert.deepEqual(runs(), ["startup"], "not run at the rotation: its turn may be hours off");

      faux.setResponses([fauxAssistantMessage("after")]);
      const two = send(mind, "main", "two");
      await waitFor(() => doneFor(two), "second done");
      assert.deepEqual(
        startup(),
        ["orientation (startup) main", "orientation (compact) main"],
        "the rotated session is oriented again",
      );

      faux.setResponses([fauxAssistantMessage("elsewhere")]);
      const three = send(mind, "other", "hi");
      await waitFor(() => doneFor(three), "other thread's done");
      assert.ok(
        events("context", "other").some((e) => e.content === "orientation (startup) other"),
        "a new thread runs its own, bound to its own thread",
      );
    }
  });

  it("a failing startup hook never fails the turn", async () => {
    const layout = makeMindDir();
    const hooks = join(layout.cwd, ".local", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "startup-context.sh"), "#!/bin/bash\nexit 1\n");
    chmodSync(join(hooks, "startup-context.sh"), 0o755);
    {
      const mind = await newMind(layout);
      faux.setResponses([fauxAssistantMessage("fine without it")]);
      const id = send(mind, "main", "hello");
      await waitFor(() => doneFor(id), "done");
      assert.ok(events("text", "main").some((e) => e.content === "fine without it"));
      assert.ok(!captured.some((e) => e.type === "error" && e.messageId === id));
    }
  });
});

describe("pi identity edits load at the next session boundary (#1201)", () => {
  /** A mind whose prompt is its SOUL.md, and a model that records the prompt it was sent. */
  async function identityMind(extra: Partial<Parameters<typeof createMind>[0]> = {}) {
    const layout = makeMindDir();
    writeFileSync(join(layout.cwd, "SOUL.md"), "I am the first soul.");
    const loader = { fail: false };
    const mind = await newMind(layout, {
      loadSystemPrompt: () => {
        if (loader.fail) throw new Error("can't read the soul right now");
        return readFileSync(join(layout.cwd, "SOUL.md"), "utf-8");
      },
      ...extra,
    });
    const { getCurrentSystemPrompt, fauxToolCall } = await import("@earendil-works/pi-ai");
    const prompts: string[] = [];
    const contexts: string[] = [];
    const reply =
      (content: Parameters<typeof fauxAssistantMessage>[0]) => (context: { messages: any[] }) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(content);
      };
    const editThroughBash = () =>
      reply(fauxToolCall("bash", { command: "echo 'I am the second soul.' > SOUL.md" }));
    /** Identity notices told on this message's turn — never another test's mind's. */
    const noticesFor = (messageId: string) =>
      captured.filter(
        (e) =>
          e.path === "events" &&
          e.type === "context" &&
          e.messageId === messageId &&
          e.metadata?.source === "identity-notice",
      );
    return {
      layout,
      mind,
      loader,
      prompts,
      contexts,
      reply,
      editThroughBash,
      fauxToolCall,
      noticesFor,
    };
  }

  it("a bash edit's tool result says when the edit loads, once per session", async () => {
    const { mind, contexts, reply, editThroughBash, fauxToolCall, noticesFor } =
      await identityMind();
    faux.setResponses([
      editThroughBash(),
      reply(fauxToolCall("bash", { command: "echo again > SOUL.md" })),
      reply("done"),
    ]);
    const id = send(mind, "main", "change who you are");
    await waitFor(() => doneFor(id), "done");

    assert.match(contexts[1], /SOUL\.md changed on disk/, "the edit's own result carries it");
    assert.match(contexts[1], /next boundary — when it rotates at the context limit/);
    assert.doesNotMatch(contexts[1], /idle minutes/, "pi has no idle resume to promise");
    assert.equal(noticesFor(id).length, 1, "told once per session, not on every later edit");
  });

  it("flags a MINDS.md that still says an edit restarts the mind", async () => {
    const { layout, mind, contexts, reply, editThroughBash } = await identityMind();
    writeFileSync(
      join(layout.cwd, "MINDS.md"),
      "Edit them — **editing any identity file (`SOUL.md`, `MEMORY.md`, `VOLUTE.md`) triggers an automatic restart**.",
    );
    faux.setResponses([editThroughBash(), reply("done")]);
    const id = send(mind, "main", "change who you are");
    await waitFor(() => doneFor(id), "done");
    assert.match(contexts[1], /Your MINDS\.md still says an identity edit restarts you/);
  });

  it("the running session keeps its prompt; a session that starts later gets the edit", async () => {
    const { mind, prompts, reply, editThroughBash } = await identityMind();
    faux.setResponses([editThroughBash(), reply("edited"), reply("still me")]);
    const one = send(mind, "main", "change who you are");
    await waitFor(() => doneFor(one), "first done");
    const two = send(mind, "main", "who are you now?");
    await waitFor(() => doneFor(two), "second done");
    assert.match(prompts[2], /first soul/, "no mid-session prompt change");
    assert.doesNotMatch(prompts[2], /second soul/);

    faux.setResponses([reply("hello from another thread")]);
    const three = send(mind, "other", "hi");
    await waitFor(() => doneFor(three), "other thread's done");
    assert.match(prompts[3], /second soul/, "a new session is built from the edited file");
  });

  it("rotation loads the edit, and says the note it carried over is no longer true", async () => {
    const { layout, mind, prompts, contexts, reply, editThroughBash } = await identityMind({
      maxContextTokens: 50,
    });
    faux.setResponses([editThroughBash(), reply("edited"), reply("rotated")]);
    const one = send(mind, "main", "change who you are");
    await waitFor(() => doneFor(one), "first done");
    await waitFor(() => existsSync(join(layout.sessionsDir, "archive")), "rotation");
    const two = send(mind, "main", "who are you now?");
    await waitFor(() => doneFor(two), "second done");
    assert.match(prompts[1], /first soul/);
    assert.match(prompts[2], /second soul/, "loaded at the rotation");
    // The rotated tail still holds the notice that called the edit pending.
    assert.match(contexts[2], /still holds the version this session started with/);
    assert.match(
      contexts[2],
      /an identity edit that an earlier note above calls pending is now loaded/,
    );
  });

  it("context info counts each thread's own prompt, not the newest one", async () => {
    const { layout, mind, reply } = await identityMind();
    faux.setResponses([reply("short soul")]);
    const one = send(mind, "main", "hi");
    await waitFor(() => doneFor(one), "main's done");
    writeFileSync(join(layout.cwd, "SOUL.md"), `I am a much longer soul. ${"x".repeat(4000)}`);
    faux.setResponses([reply("long soul")]);
    const two = send(mind, "other", "hi");
    await waitFor(() => doneFor(two), "other's done");

    const info = await mind.getContextInfo();
    const tokensOf = (name: string) =>
      info.sessions.find((x) => x.name === name)?.breakdown?.systemPrompt;
    assert.ok(tokensOf("main")! < 100, "main still runs the short prompt it started with");
    assert.ok(tokensOf("other")! > 500, "other runs the long one");
  });

  it("a failed rebuild keeps the old prompt and tells the mind its edit didn't load", async () => {
    const {
      layout,
      mind,
      loader,
      prompts,
      contexts,
      reply,
      editThroughBash,
      fauxToolCall,
      noticesFor,
    } = await identityMind({ maxContextTokens: 50 });
    faux.setResponses([
      editThroughBash(),
      (context: { messages: any[] }) => {
        loader.fail = true; // the rotation after this turn can't rebuild
        return reply("edited")(context);
      },
      reply(fauxToolCall("bash", { command: "true" })),
      reply("still the old me"),
    ]);
    const one = send(mind, "main", "change who you are");
    await waitFor(() => doneFor(one), "first done");
    await waitFor(() => existsSync(join(layout.sessionsDir, "archive")), "rotation");
    const two = send(mind, "main", "who are you now?");
    await waitFor(() => doneFor(two), "second done");
    assert.match(prompts[2], /first soul/, "the last good prompt is kept");
    // (The rotated tail also carries turn one's notice, so look at this turn's own.)
    assert.equal(noticesFor(two).length, 1, "and the mind is told on its next tool");
    assert.doesNotMatch(
      contexts[2],
      /is now loaded/,
      "never told a pending edit loaded when it didn't",
    );
  });
});

describe("pi rotation failure leaves nothing to resurrect", () => {
  it("moves the lost transcript where neither a resume nor a wake seed finds it", {
    skip: asRoot && "chmod can't block root's read",
  }, async () => {
    const layout = makeMindDir();
    const dir = join(layout.sessionsDir, "main");
    const mind = await newMind(layout, { maxContextTokens: 50 });
    faux.setResponses([fauxAssistantMessage("over the limit")]);
    let blocked = false;
    send(mind, "main", "the thing I was told I lost", (e) => {
      if (e.type === "done" && !blocked) {
        blocked = true;
        for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) chmodSync(join(dir, f), 0o200);
      }
    });
    await waitFor(() => notices().length > 0, "rotation-failure notice");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".jsonl")),
      [],
      "the live dir holds no transcript the mind was told it lost",
    );
    const [lost] = readdirSync(join(layout.sessionsDir, "archive"));
    assert.match(lost, /^main-.*-lost$/, "kept on disk, under a name no seed matches");
    for (const f of readdirSync(join(layout.sessionsDir, "archive", lost)))
      chmodSync(join(layout.sessionsDir, "archive", lost, f), 0o600);

    // The server restarts before the fresh session ever replied.
    const restarted = await newMind(layout);
    let seen = "";
    faux.setResponses([
      (context: { messages: unknown[] }) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage("fresh");
      },
    ]);
    const id = send(restarted, "main", "hello again");
    await waitFor(() => doneFor(id), "done after restart");
    assert.doesNotMatch(seen, /the thing I was told I lost/, "nothing came back");
    assert.ok(
      !captured.some((e) => e.messageId === id && e.metadata?.source === "seeded-session"),
      "no restored-session note",
    );
  });
});
