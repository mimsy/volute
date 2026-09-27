import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildSeededPiTranscript,
  estimatePiEntryTokens,
  findLatestArchivedPiSession,
  hasLivePiSession,
  RECALL_CUSTOM_TYPE,
  rotatePiSession,
  seedPiSession,
} from "../templates/_base/src/lib/pi-session-seed.js";
import { buildSeededNote } from "../templates/_base/src/lib/seed-note.js";
import {
  RECALL_PREAMBLE,
  type RecallEntry,
  type RecollectionQuery,
  TRIMMED_TURN_MARKER,
} from "../templates/_base/src/lib/session-seed.js";

// --- Pi session-file line builders (mirror the real on-disk JSONL shapes) ---

const SRC_ID = "src-session-0000";

function header(id = SRC_ID, cwd = "/orig/home"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-07-18T00:00:00.000Z",
    cwd,
  });
}

function userMsg(id: string, parentId: string | null, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-18T00:00:01.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  });
}

function assistantMsg(id: string, parentId: string, blocks: unknown[]): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-18T00:00:02.000Z",
    message: {
      role: "assistant",
      content: blocks,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: { totalTokens: 1 },
      stopReason: "stop",
      timestamp: 0,
    },
  });
}

function toolResultMsg(id: string, parentId: string, toolCallId: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-18T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "Bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    },
  });
}

/** A non-message entry that lives inside a turn (must not be a boundary). */
function modelChange(id: string, parentId: string): string {
  return JSON.stringify({
    type: "model_change",
    id,
    parentId,
    timestamp: "2026-07-18T00:00:04.000Z",
    provider: "anthropic",
    modelId: "claude-sonnet-4",
  });
}

function parse(lines: string[]): Record<string, any>[] {
  return lines.map((l) => JSON.parse(l));
}

function scratch(): string {
  return mkdtempSync(resolve(tmpdir(), "pi-seed-"));
}

/** Write a source transcript into an archive dir and return the archive layout. */
function makeArchive(
  piSessionsDir: string,
  name: string,
  ts: string,
  transcriptLines: string[],
  filename = "2026-07-18T00-00-00-000Z_src-session-0000.jsonl",
): string {
  const dir = resolve(piSessionsDir, "archive", `${name}-${ts}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), `${transcriptLines.join("\n")}\n`);
  return dir;
}

// --- buildSeededPiTranscript: turn boundaries ------------------------------

describe("buildSeededPiTranscript — turn boundaries", () => {
  it("keeps a whole turn including its tool_result continuation", () => {
    const lines = [
      header(),
      userMsg("u1", null, "first prompt"),
      assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
      userMsg("u2", "a1", "second prompt"),
      assistantMsg("a2", "u2", [{ type: "toolCall", id: "t1", name: "Bash", input: {} }]),
      toolResultMsg("tr1", "a2", "t1"),
      assistantMsg("a3", "tr1", [{ type: "text", text: "done" }]),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 1_000_000 });
    assert.ok(res);
    // header + all 6 entries (both turns fit).
    assert.equal(res.lines.length, 7);
  });

  it("treats only user-role messages as boundaries (toolResult/model_change are continuations)", () => {
    // One turn whose body has a model_change and a toolResult — a tight budget
    // must keep the whole turn, not split at the non-user entries.
    const lines = [
      header(),
      userMsg("u1", null, "x".repeat(400)),
      assistantMsg("a1", "u1", [{ type: "text", text: "y".repeat(400) }]),
      userMsg("u2", "a1", "second"),
      modelChange("m1", "u2"),
      assistantMsg("a2", "u2", [{ type: "toolCall", id: "t1", name: "Bash", input: {} }]),
      toolResultMsg("tr1", "a2", "t1"),
      assistantMsg("a3", "tr1", [{ type: "text", text: "done" }]),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 60 });
    assert.ok(res);
    // header + turn2's 5 entries (u2, m1, a2, tr1, a3).
    assert.equal(res.lines.length, 6);
    const objs = parse(res.lines);
    assert.equal(objs[1].message.content, "second");
    assert.ok(objs.some((o) => o.type === "model_change"));
    assert.ok(objs.some((o) => o.message?.role === "toolResult"));
  });
});

// --- buildSeededPiTranscript: budget selection -----------------------------

describe("buildSeededPiTranscript — token budget selection", () => {
  it("takes as many whole trailing turns as fit in the budget", () => {
    const big = "z".repeat(3600); // 2000 est tokens per turn (1.8 chars/token)
    const lines = [
      header(),
      userMsg("u1", null, big),
      userMsg("u2", "u1", big),
      userMsg("u3", "u2", big),
    ];
    // Budget fits two turns (4000) but not three (6000).
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 5000 });
    assert.ok(res);
    // header + 2 entries.
    assert.equal(res.lines.length, 3);
    const objs = parse(res.lines);
    assert.equal(objs[1].id, "u2");
    assert.equal(objs[2].id, "u3");
  });

  it("always keeps at least the final turn even when it alone exceeds the budget", () => {
    const lines = [
      header(),
      userMsg("u1", null, "small"),
      userMsg("u2", "u1", "q".repeat(4000)), // ~1000 est tokens
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 10 });
    assert.ok(res);
    assert.equal(res.lines.length, 2); // header + u2
    assert.equal(parse(res.lines)[1].id, "u2");
  });
});

// --- buildSeededPiTranscript: header + entry rewrites ----------------------

describe("buildSeededPiTranscript — rewrites", () => {
  it("writes a fresh header (new id, rewritten cwd, source recorded) and preserves version", () => {
    const lines = [
      header(SRC_ID, "/orig/home"),
      userMsg("u1", null, "hello"),
      assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), {
      cwd: "/new/home",
      seedTokens: 1_000_000,
      sourcePath: "/archive/src.jsonl",
    });
    assert.ok(res);
    const h = parse(res.lines)[0];
    assert.equal(h.type, "session");
    assert.equal(h.version, 3);
    assert.equal(h.id, res.sessionId);
    assert.notEqual(h.id, SRC_ID);
    assert.equal(h.cwd, resolve("/new/home"));
    assert.equal(h.parentSession, "/archive/src.jsonl");
  });

  it("nulls the first kept entry's parentId and keeps every other entry verbatim", () => {
    const srcUser = userMsg("u2", "a1", "second");
    const srcAssistant = assistantMsg("a2", "u2", [{ type: "text", text: "done" }]);
    const lines = [
      header(),
      userMsg("u1", null, "first"),
      assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
      srcUser,
      srcAssistant,
    ];
    // Budget keeps only the final turn (u2, a2).
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 5 });
    assert.ok(res);
    assert.equal(res.lines.length, 3); // header + u2 + a2
    const objs = parse(res.lines);
    // First kept entry: same content, but parentId detached to null.
    assert.equal(objs[1].id, "u2");
    assert.equal(objs[1].parentId, null);
    assert.equal(objs[1].message.content, "second");
    // Later entry is byte-for-byte identical to the source line.
    assert.equal(res.lines[2], srcAssistant);
  });
});

// --- buildSeededPiTranscript: degenerate inputs ----------------------------

describe("buildSeededPiTranscript — degenerate inputs", () => {
  it("returns null for empty input", () => {
    assert.equal(buildSeededPiTranscript("", { cwd: "/home", seedTokens: 1000 }), null);
    assert.equal(buildSeededPiTranscript("   \n\n", { cwd: "/home", seedTokens: 1000 }), null);
  });

  it("returns null when the first line is not a session header", () => {
    const lines = [userMsg("u1", null, "no header here")];
    assert.equal(
      buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null when there is no genuine (user) turn", () => {
    const lines = [
      header(),
      assistantMsg("a1", null, [{ type: "text", text: "orphan assistant" }]),
      toolResultMsg("tr1", "a1", "t1"),
    ];
    assert.equal(
      buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null on a corrupt (non-JSON) line", () => {
    const lines = [header(), userMsg("u1", null, "hi"), "{not valid json"];
    assert.equal(
      buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 1000 }),
      null,
    );
  });
});

// --- Archive directory lookup + name disambiguation ------------------------

describe("findLatestArchivedPiSession", () => {
  it("returns null when there is no archive dir", () => {
    const base = scratch();
    assert.equal(findLatestArchivedPiSession(resolve(base, ".mind/pi-sessions"), "main"), null);
  });

  it("picks the newest archived dir for the exact session name, with archived-at", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T00-00", [header(), userMsg("u1", null, "a")]);
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [header(), userMsg("u1", null, "b")]);
    const found = findLatestArchivedPiSession(piSessionsDir, "main");
    assert.ok(found);
    assert.match(found.dir, /main-2026-07-18T09-30$/);
    assert.equal(found.archivedAt, Date.UTC(2026, 6, 18, 9, 30));
  });

  it("disambiguates `main` from `main-thread`", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T00-00", [header(), userMsg("u1", null, "a")]);
    makeArchive(piSessionsDir, "main-thread", "2026-07-18T09-30", [
      header(),
      userMsg("u1", null, "b"),
    ]);
    const main = findLatestArchivedPiSession(piSessionsDir, "main");
    assert.ok(main);
    assert.match(main.dir, /\/main-2026-07-18T00-00$/);
    const thread = findLatestArchivedPiSession(piSessionsDir, "main-thread");
    assert.ok(thread);
    assert.match(thread.dir, /main-thread-2026-07-18T09-30$/);
  });

  it("ignores dirs whose suffix is not a valid timestamp", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "not-a-timestamp", [header(), userMsg("u1", null, "a")]);
    assert.equal(findLatestArchivedPiSession(piSessionsDir, "main"), null);
  });
});

// --- hasLivePiSession ------------------------------------------------------

describe("hasLivePiSession", () => {
  it("is true only when a live .jsonl exists for the name", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    assert.equal(hasLivePiSession(piSessionsDir, "main"), false);
    const live = resolve(piSessionsDir, "main");
    mkdirSync(live, { recursive: true });
    assert.equal(hasLivePiSession(piSessionsDir, "main"), false);
    writeFileSync(resolve(live, "sess.jsonl"), "{}");
    assert.equal(hasLivePiSession(piSessionsDir, "main"), true);
  });
});

// --- seedPiSession: end-to-end wiring --------------------------------------

describe("seedPiSession", () => {
  const transcript = () => [
    header(SRC_ID, "/orig/home"),
    userMsg("u1", null, "first prompt"),
    assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
    userMsg("u2", "a1", "second prompt"),
    assistantMsg("a2", "u2", [{ type: "text", text: "done" }]),
  ];

  it("writes a seed file into a fresh live dir and returns the new session id + archived-at", async () => {
    const home = resolve(scratch(), "home");
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());

    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
    });
    assert.ok(seeded);
    assert.equal(seeded.archivedAt, Date.UTC(2026, 6, 18, 9, 30));

    const liveDir = resolve(piSessionsDir, "main");
    const files = readdirSync(liveDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const written = readFileSync(resolve(liveDir, files[0]), "utf-8").trim().split("\n");
    const h = JSON.parse(written[0]);
    assert.equal(h.id, seeded.sessionId);
    assert.equal(h.cwd, resolve(home));
  });

  it("returns null when there is no archive", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null when the archive dir has no jsonl", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    mkdirSync(resolve(piSessionsDir, "archive", "main-2026-07-18T09-30"), { recursive: true });
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null on a corrupt source transcript", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [header(), "{bad json"]);
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("never seeds an ephemeral new-* session", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "new-abc", "2026-07-18T09-30", transcript());
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "new-abc", seedTokens: 1000 }),
      null,
    );
  });

  it("is disabled when seedTokens is 0", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 0 }),
      null,
    );
  });

  it("does not seed over an existing live session", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());
    const liveDir = resolve(piSessionsDir, "main");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(resolve(liveDir, "existing.jsonl"), `${header("live-id")}\n`);
    assert.equal(
      await seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });
});

// --- Load-bearing: the real SessionManager resumes the seed ----------------

describe("seedPiSession + SessionManager.continueRecent (real SDK)", () => {
  it("continueRecent adopts the seeded file and exposes the prior conversation", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [
      header(SRC_ID, "/orig/home"),
      userMsg("u1", null, "first prompt"),
      assistantMsg("a1", "u1", [{ type: "text", text: "hi there" }]),
      userMsg("u2", "a1", "second prompt"),
      assistantMsg("a2", "u2", [{ type: "text", text: "all done" }]),
    ]);

    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
    });
    assert.ok(seeded);

    // Exactly as agent.ts calls it: cwd = home dir, sessionDir = <base>/<name>.
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "main"));
    // The SDK adopted our seed: its header id is the one we generated.
    assert.equal(sm.getSessionId(), seeded.sessionId);

    // The prior conversation is present in the resumed context.
    const { messages } = sm.buildSessionContext();
    const texts = JSON.stringify(messages);
    assert.ok(messages.length >= 4);
    assert.match(texts, /first prompt/);
    assert.match(texts, /all done/);
  });

  it("does NOT adopt the seed when the header cwd doesn't match (cwd rewrite is load-bearing)", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [
      header(SRC_ID, "/orig/home"),
      userMsg("u1", null, "hi"),
      assistantMsg("a1", "u1", [{ type: "text", text: "yo" }]),
    ]);
    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
    });
    assert.ok(seeded);

    // Resume with a DIFFERENT cwd than the seed header records: the SDK's cwd
    // filter rejects the file and mints a fresh session instead.
    const sm = SessionManager.continueRecent(
      resolve(home, "elsewhere"),
      resolve(piSessionsDir, "main"),
    );
    assert.notEqual(sm.getSessionId(), seeded.sessionId);
  });
});

// --- rotatePiSession: orchestrator over the filesystem ---------------------

describe("rotatePiSession", () => {
  const liveTranscript = () => [
    header(SRC_ID, "/orig/home"),
    userMsg("u1", null, "first prompt"),
    assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
    userMsg("u2", "a1", "second prompt"),
    assistantMsg("a2", "u2", [{ type: "text", text: "done" }]),
  ];

  /** Write a live session file into `<piSessionsDir>/<name>/` and return its path. */
  function makeLive(piSessionsDir: string, name: string, lines: string[]): string {
    const dir = resolve(piSessionsDir, name);
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "2026-07-18T00-00-00-000Z_src-session-0000.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  it("writes the budget tail into the live dir and archives the old file", async () => {
    const home = resolve(scratch(), "home");
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    const sourcePath = makeLive(piSessionsDir, "main", liveTranscript());

    const newPath = (
      await rotatePiSession({
        cwd: home,
        sessionsDir: piSessionsDir,
        name: "main",
        sourcePath,
        seedTokens: 1_000_000, // large → whole transcript
      })
    )?.path;
    assert.ok(newPath);

    // Live dir now holds only the rotated session (old file moved out).
    const liveDir = resolve(piSessionsDir, "main");
    const liveFiles = readdirSync(liveDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(liveFiles.length, 1);
    assert.equal(resolve(liveDir, liveFiles[0]), newPath);

    // The new file is the budget-based tail; here the budget kept the whole
    // transcript, with the first kept entry detached to a clean root.
    const rotated = readFileSync(newPath, "utf-8").trim().split("\n");
    const objs = parse(rotated);
    assert.equal(objs[0].cwd, resolve(home));
    assert.equal(objs[1].parentId, null);
    assert.deepEqual(
      objs.slice(1).map((o) => o.id),
      ["u1", "a1", "u2", "a2"],
    );

    // Old file archived under archive/<name>-<ts>/, matching sleep-manager's layout.
    const archiveBase = resolve(piSessionsDir, "archive");
    const archived = readdirSync(archiveBase);
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^main-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
    const archivedFiles = readdirSync(resolve(archiveBase, archived[0]));
    assert.ok(archivedFiles.some((f) => f.endsWith(".jsonl")));
  });

  it("keeps only the trailing turns that fit a tight budget", async () => {
    const home = resolve(scratch(), "home");
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    // Two turns; a tiny budget keeps only the last.
    const sourcePath = makeLive(piSessionsDir, "main", [
      header(SRC_ID, "/orig/home"),
      userMsg("u1", null, "first"),
      userMsg("u2", "u1", "q".repeat(4000)),
    ]);
    const newPath = (
      await rotatePiSession({
        cwd: home,
        sessionsDir: piSessionsDir,
        name: "main",
        sourcePath,
        seedTokens: 10,
      })
    )?.path;
    assert.ok(newPath);
    const objs = parse(readFileSync(newPath, "utf-8").trim().split("\n"));
    assert.deepEqual(
      objs.slice(1).map((o) => o.id),
      ["u2"],
    );
  });

  it("returns null when the source file can't be read", async () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    assert.equal(
      await rotatePiSession({
        cwd: "/home",
        sessionsDir: piSessionsDir,
        name: "main",
        sourcePath: resolve(piSessionsDir, "main", "missing.jsonl"),
        seedTokens: 1000,
      }),
      null,
    );
  });

  it("does not archive for ephemeral new-* names", async () => {
    const home = resolve(scratch(), "home");
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    const sourcePath = makeLive(piSessionsDir, "new-abc", liveTranscript());
    const newPath = (
      await rotatePiSession({
        cwd: home,
        sessionsDir: piSessionsDir,
        name: "new-abc",
        sourcePath,
        seedTokens: 1_000_000,
      })
    )?.path;
    assert.ok(newPath);
    // No archive dir created for ephemeral sessions.
    assert.equal(readdirSync(piSessionsDir).includes("archive"), false);
  });
});

// --- Boundary note cause ---------------------------------------------------

describe("rotation boundary note", () => {
  it("uses the rotation wording (context limit, points at history) not the restored one", () => {
    const note = buildSeededNote({ cause: "rotation" });
    assert.match(note, /consolidated at the context limit/);
    assert.match(note, /volute mind history/);
    assert.doesNotMatch(note, /restored after archival/);
  });
});

// --- Load-bearing: a live SessionManager adopts the rotated session ---------

describe("rotatePiSession + SessionManager adoption (real SDK)", () => {
  it("switching the live SessionManager to the rotated file exposes only the tail", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    const liveDir = resolve(piSessionsDir, "main");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      resolve(liveDir, "2026-07-18T00-00-00-000Z_src-session-0000.jsonl"),
      `${[
        header(SRC_ID, resolve(home)),
        userMsg("u1", null, "oldest turn"),
        assistantMsg("a1", "u1", [{ type: "text", text: "reply one" }]),
        userMsg("u2", "a1", "middle turn"),
        assistantMsg("a2", "u2", [{ type: "text", text: "reply two" }]),
        userMsg("u3", "a2", "newest turn"),
        assistantMsg("a3", "u3", [{ type: "text", text: "reply three" }]),
      ].join("\n")}\n`,
    );

    // A live SessionManager, exactly as the running mind holds one.
    const sm = SessionManager.continueRecent(home, liveDir);
    const sourcePath = sm.getSessionFile();
    assert.ok(sourcePath);
    // Full history is present before rotation.
    assert.ok(sm.buildSessionContext().messages.length >= 6);

    // Rotate onto the budget tail — this is what rotateInPlace does, minus the
    // agent.state re-sync (which assigns the value below). A tight budget keeps only
    // the final turn (u3 onward), so the assertion is deterministic.
    const newPath = (
      await rotatePiSession({
        cwd: home,
        sessionsDir: piSessionsDir,
        name: "main",
        sourcePath,
        seedTokens: 1,
      })
    )?.path;
    assert.ok(newPath);

    // The load-bearing adoption step: switch the live SM to the rotated file.
    sm.setSessionFile(newPath);
    const adopted = sm.buildSessionContext();

    // The SM now reports the rotated session id and only the budget tail (u3 onward);
    // the collapsed turns are gone. rotateInPlace assigns exactly adopted.messages to
    // the agent's live context, so this is what the mind would see post-rotation.
    assert.notEqual(sm.getSessionId(), SRC_ID);
    const text = JSON.stringify(adopted.messages);
    assert.match(text, /newest turn/);
    assert.match(text, /reply three/);
    assert.doesNotMatch(text, /oldest turn/);
    assert.doesNotMatch(text, /middle turn/);

    // And a fresh continueRecent (next restart) picks the rotated file too.
    const reopened = SessionManager.continueRecent(home, liveDir);
    assert.equal(reopened.getSessionId(), sm.getSessionId());
  });
});

// --- Ephemeral new-* sessions are file-backed (so rotation applies) --------

describe("ephemeral new-* sessions (file-backed, real SDK)", () => {
  it("continueRecent on a fresh new-* dir creates a real file-backed session", () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    // Exactly as agent.ts now creates ephemerals: continueRecent on a name-scoped dir.
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "new-123-abc"));
    // Not inMemory: it is persisted and has a concrete session file path — so the
    // file-based rotation applies to it just like a persistent session.
    assert.ok(sm.isPersisted());
    assert.ok(sm.getSessionFile());
  });

  it("a persistent 'main' start never adopts an ephemeral's session file", () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    // An ephemeral's transcript exists under its own name-scoped dir, with a
    // matching cwd (so it's not the cwd filter that saves us — it's name scoping).
    const ephDir = resolve(piSessionsDir, "new-123-abc");
    mkdirSync(ephDir, { recursive: true });
    writeFileSync(
      resolve(ephDir, "2026-07-19T00-00-00-000Z_eph.jsonl"),
      `${[header("eph-id", resolve(home)), userMsg("u1", null, "ephemeral turn")].join("\n")}\n`,
    );
    // A fresh 'main' resumes from its OWN (empty) dir, never the ephemeral's.
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "main"));
    assert.notEqual(sm.getSessionId(), "eph-id");
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /ephemeral turn/);
  });

  it("rotates a file-backed ephemeral onto the tail but writes no archive", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    const ephDir = resolve(piSessionsDir, "new-xyz");
    mkdirSync(ephDir, { recursive: true });
    writeFileSync(
      resolve(ephDir, "2026-07-19T00-00-00-000Z_eph.jsonl"),
      `${[
        header("eph-id", resolve(home)),
        userMsg("u1", null, "first"),
        assistantMsg("a1", "u1", [{ type: "text", text: "hi" }]),
        userMsg("u2", "a1", "second"),
        assistantMsg("a2", "u2", [{ type: "text", text: "done" }]),
      ].join("\n")}\n`,
    );

    const sm = SessionManager.continueRecent(home, ephDir);
    const sourcePath = sm.getSessionFile();
    assert.ok(sourcePath);
    const newPath = (
      await rotatePiSession({
        cwd: home,
        sessionsDir: piSessionsDir,
        name: "new-xyz",
        sourcePath,
        seedTokens: 1,
      })
    )?.path;
    assert.ok(newPath);
    // Ephemeral rotation writes no archive (no pointer/archive for one-offs).
    assert.equal(readdirSync(piSessionsDir).includes("archive"), false);
    // Adoption still works: switch the live SM to the rotated tail.
    sm.setSessionFile(newPath);
    const text = JSON.stringify(sm.buildSessionContext().messages);
    assert.match(text, /second/);
    assert.doesNotMatch(text, /first/);
  });
});

// --- Estimator: what an entry actually sends the model -----------------------

describe("estimatePiEntryTokens", () => {
  const entry = (o: Record<string, unknown>) => o as Parameters<typeof estimatePiEntryTokens>[0];

  it("counts an image at a flat cost, not by its base64 size", () => {
    const withImage = entry({
      type: "message",
      message: { role: "user", content: [{ type: "image", data: "A".repeat(500_000) }] },
    });
    assert.equal(estimatePiEntryTokens(withImage), 1600);
  });

  it("counts thinking by its signature when the provider keeps one", () => {
    const thinking = entry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "short summary", thinkingSignature: "s".repeat(400) },
        ],
      },
    });
    assert.equal(estimatePiEntryTokens(thinking), 100);
  });

  it("counts visible text, not line metadata", () => {
    const text = entry({
      type: "message",
      id: "x".repeat(1000),
      message: { role: "user", content: "a".repeat(180), usage: { big: "y".repeat(1000) } },
    });
    assert.equal(estimatePiEntryTokens(text), 100);
  });

  it("costs nothing for entries pi keeps out of context", () => {
    assert.equal(
      estimatePiEntryTokens(entry({ type: "model_change", modelId: "m".repeat(900) })),
      0,
    );
    assert.equal(estimatePiEntryTokens(entry({ type: "custom", data: "d".repeat(900) })), 0);
  });

  it("counts a bash execution by its command and output, unless excluded", () => {
    const run = (excludeFromContext: boolean) =>
      entry({
        type: "message",
        message: {
          role: "bashExecution",
          command: "ls",
          output: "o".repeat(178),
          excludeFromContext,
        },
      });
    assert.equal(estimatePiEntryTokens(run(false)), 100);
    assert.equal(estimatePiEntryTokens(run(true)), 0);
  });

  it("counts a context edit's replacement content", () => {
    const edit = entry({
      type: "context_edit",
      targetId: "x",
      replacement: { content: "r".repeat(180) },
    });
    assert.equal(estimatePiEntryTokens(edit), 100);
  });

  it("counts a custom message's content — pi sends it as a user message", () => {
    assert.equal(
      estimatePiEntryTokens(entry({ type: "custom_message", content: "c".repeat(180) })),
      100,
    );
  });
});

// --- Trimming an over-budget final turn ---------------------------------------

/** A long tool loop: one prompt, `steps` tool calls each with a big result, then a reply. */
function toolLoop(steps: number, resultChars = 1800): string[] {
  const lines = [
    header(),
    userMsg("u0", null, "earlier"),
    assistantMsg("a0", "u0", [{ type: "text", text: "ok" }]),
  ];
  lines.push(userMsg("u1", "a0", "do the long thing"));
  let parent = "u1";
  for (let k = 0; k < steps; k++) {
    lines.push(
      assistantMsg(`a${k + 1}`, parent, [
        { type: "toolCall", id: `t${k}`, name: "Bash", arguments: {} },
      ]),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: `r${k}`,
        parentId: `a${k + 1}`,
        timestamp: "2026-07-18T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: `t${k}`,
          toolName: "Bash",
          content: [{ type: "text", text: "x".repeat(resultChars) }],
          isError: false,
          timestamp: 0,
        },
      }),
    );
    parent = `r${k}`;
  }
  lines.push(assistantMsg("af", parent, [{ type: "text", text: "finished" }]));
  return lines;
}

const markerCount = (lines: string[]) =>
  lines.join("\n").split(JSON.stringify(TRIMMED_TURN_MARKER).slice(1, -1)).length - 1;

/** Every toolResult in `objs` answers a toolCall that is also in `objs`. */
function assertNoOrphanResults(objs: Record<string, any>[]) {
  const calls = new Set<string>();
  for (const o of objs) {
    if (o.message?.role === "assistant") {
      for (const b of o.message.content) if (b.type === "toolCall") calls.add(b.id);
    }
  }
  for (const o of objs) {
    if (o.message?.role === "toolResult") assert.ok(calls.has(o.message.toolCallId), o.id);
  }
}

describe("buildSeededPiTranscript — trimming an over-budget final turn", () => {
  it("keeps the prompt, marked, then the latest whole steps that fit", () => {
    // Each step is a 1000-token result; the turn is ~10k against a 3500 budget.
    const res = buildSeededPiTranscript(toolLoop(10).join("\n"), {
      cwd: "/home",
      seedTokens: 3500,
    });
    assert.ok(res);
    const objs = parse(res.lines).slice(1);
    assert.equal(objs[0].id, "u1");
    assert.equal(objs[0].parentId, null);
    assert.equal(objs[0].message.content.at(-1).text, TRIMMED_TURN_MARKER);
    assert.equal(objs[0].message.content[0].text, "do the long thing");
    // Resumed at a step start, re-linked onto the prompt.
    assert.equal(objs[1].message.role, "assistant");
    assert.equal(objs[1].parentId, "u1");
    assert.equal(objs.at(-1).id, "af");
    assert.ok(objs.length < 20, "the turn was cut");
    const total = objs.reduce((sum, o) => sum + estimatePiEntryTokens(o as never), 0);
    assert.ok(total <= 3500, `seed ~${Math.round(total)} tokens is over budget`);
    assertNoOrphanResults(objs);
  });

  it("floors at the prompt plus the final step", () => {
    const res = buildSeededPiTranscript(toolLoop(4).join("\n"), { cwd: "/home", seedTokens: 1 });
    assert.ok(res);
    const objs = parse(res.lines).slice(1);
    assert.deepEqual(
      objs.map((o) => o.id),
      ["u1", "af"],
    );
    assert.equal(objs[1].parentId, "u1");
  });

  it("never splits a response's parallel tool calls from their results", () => {
    const lines = [
      header(),
      userMsg("u1", null, "go"),
      assistantMsg("a1", "u1", [
        { type: "toolCall", id: "p1", name: "Bash", arguments: {} },
        { type: "toolCall", id: "p2", name: "Bash", arguments: {} },
      ]),
      toolResultMsg("r1", "a1", "p1"),
      toolResultMsg("r2", "r1", "p2"),
      assistantMsg("a2", "r2", [{ type: "text", text: "z".repeat(3600) }]),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 100 });
    assert.ok(res);
    assertNoOrphanResults(parse(res.lines));
  });

  it("re-seeding a trimmed seed keeps one marker, counted once", () => {
    const first = buildSeededPiTranscript(toolLoop(10).join("\n"), {
      cwd: "/home",
      seedTokens: 3500,
    });
    assert.ok(first);
    // A tighter budget cuts the already-trimmed turn again.
    const again = buildSeededPiTranscript(first.lines.join("\n"), {
      cwd: "/home",
      seedTokens: 2400,
    });
    assert.ok(again);
    assert.equal(markerCount(again.lines), 1);
    const objs = parse(again.lines).slice(1);
    assert.ok(objs.length < parse(first.lines).length - 1, "cut again");
    const total = objs.reduce((sum, o) => sum + estimatePiEntryTokens(o as never), 0);
    assert.ok(total <= 2400, `seed ~${Math.round(total)} tokens is over budget`);
  });

  it("the real SessionManager resumes the whole trimmed chain, prompt to final step", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", toolLoop(10));
    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 3500,
    });
    assert.ok(seeded);
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "main"));
    assert.equal(sm.getSessionId(), seeded.sessionId);
    const { messages } = sm.buildSessionContext();
    const file = readdirSync(resolve(piSessionsDir, "main"))[0];
    const onDisk = readFileSync(resolve(piSessionsDir, "main", file), "utf-8")
      .trim()
      .split("\n");
    // Every seeded entry is on the path from the leaf: none cut off by a broken link.
    assert.equal(messages.length, onDisk.length - 1);
    assert.match(JSON.stringify(messages[0]), /do the long thing/);
    assert.match(JSON.stringify(messages[0]), /left out to keep room to think/);
    assert.match(JSON.stringify(messages.at(-1)), /finished/);
  });
});

// --- Recollection -----------------------------------------------------------

const RECALL: RecallEntry[] = [
  {
    period: "day",
    period_key: "2026-07-16",
    start: "2026-07-16T00:00:00.000Z",
    end: "2026-07-17T00:00:00.000Z",
    content: "I rewrote the pond poem twice.",
    author: "mind",
  },
  {
    period: "hour",
    period_key: "2026-07-17T09",
    start: "2026-07-17T09:00:00.000Z",
    end: "2026-07-17T10:00:00.000Z",
    content: "Talked with alice about moss.",
    author: "consolidation",
  },
];

const convo = () => [
  header(SRC_ID, "/orig/home"),
  userMsg("u1", null, "first prompt"),
  assistantMsg("a1", "u1", [{ type: "text", text: "hi there" }]),
  userMsg("u2", "a1", "second prompt"),
  assistantMsg("a2", "u2", [{ type: "text", text: "all done" }]),
];

describe("seedPiSession / rotatePiSession — recollection", () => {
  function setup(lines = convo()) {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", lines);
    return { home, piSessionsDir };
  }

  function readSeed(piSessionsDir: string, name = "main") {
    const dir = resolve(piSessionsDir, name);
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    assert.ok(file);
    return readFileSync(resolve(dir, file), "utf-8").trim().split("\n");
  }

  it("asks for memories before the archive time, up to where the tail starts", async () => {
    const { home, piSessionsDir } = setup();
    const queries: RecollectionQuery[] = [];
    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      recollect: async (q) => {
        queries.push(q);
        return RECALL;
      },
      timeZone: "UTC",
    });
    assert.ok(seeded);
    assert.equal(seeded.recallEntries, 2);
    assert.deepEqual(queries, [
      { before: "2026-07-18T09:30:00.000Z", tailStartedAt: "2026-07-18T00:00:01.000Z" },
    ]);
    const objs = parse(readSeed(piSessionsDir)).slice(1);
    assert.deepEqual(
      objs.map((o) => o.type === "custom_message" && o.customType === RECALL_CUSTOM_TYPE),
      [true, true, false, false, false, false],
    );
    assert.ok(
      objs[0].content.startsWith(
        `${RECALL_PREAMBLE}\n[recall: Thursday 16 Jul — you wrote this one]`,
      ),
    );
    assert.equal(objs[0].parentId, null);
    assert.equal(objs[1].parentId, objs[0].id);
    assert.equal(objs[2].id, "u1");
    assert.equal(objs[2].parentId, objs[1].id);
  });

  it("reaches the model: the real SessionManager puts the memories ahead of the tail", async () => {
    const { home, piSessionsDir } = setup();
    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      recollect: async () => RECALL,
      timeZone: "UTC",
    });
    assert.ok(seeded);
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "main"));
    assert.equal(sm.getSessionId(), seeded.sessionId);
    const llm = convertToLlm(sm.buildSessionContext().messages);
    assert.deepEqual(
      llm.map((m) => m.role),
      ["user", "user", "user", "assistant", "user", "assistant"],
    );
    assert.match(JSON.stringify(llm[0]), /pond poem/);
    assert.match(JSON.stringify(llm[1]), /moss/);
    assert.match(JSON.stringify(llm[2]), /first prompt/);
  });

  for (const [what, recollect] of [
    [
      "rejects",
      async () => {
        throw new Error("daemon down");
      },
    ],
    ["returns malformed entries", async () => [{ nope: true }]],
  ] as const) {
    it(`fails soft to a tail-only seed when recollection ${what}`, async () => {
      const { home, piSessionsDir } = setup();
      const seeded = await seedPiSession({
        cwd: home,
        piSessionsDir,
        name: "main",
        seedTokens: 1_000_000,
        recollect,
      });
      assert.ok(seeded);
      assert.equal(seeded.recallEntries, 0);
      const objs = parse(readSeed(piSessionsDir)).slice(1);
      assert.equal(objs[0].id, "u1");
      assert.equal(objs[0].parentId, null);
    });
  }

  it("re-seeding a seeded transcript replaces its recall entries rather than keeping them", async () => {
    const { home, piSessionsDir } = setup();
    await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      recollect: async () => RECALL,
    });
    const again = buildSeededPiTranscript(readSeed(piSessionsDir).join("\n"), {
      cwd: home,
      seedTokens: 1_000_000,
      recall: [RECALL[1]],
    });
    assert.ok(again);
    const objs = parse(again.lines).slice(1);
    assert.equal(objs.filter((o) => o.type === "custom_message").length, 1);
    assert.match(objs[0].content, /moss/);
    assert.equal(objs[1].id, "u1");
    assert.equal(objs[1].parentId, objs[0].id);
  });

  it("rotation seeds recollection ahead of its tail and reports how many", async () => {
    const home = resolve(scratch(), "home");
    const sessionsDir = resolve(scratch(), ".mind/pi-sessions");
    const liveDir = resolve(sessionsDir, "main");
    mkdirSync(liveDir, { recursive: true });
    const sourcePath = resolve(liveDir, "2026-07-18T00-00-00-000Z_src.jsonl");
    writeFileSync(sourcePath, `${convo().join("\n")}\n`);
    const queries: RecollectionQuery[] = [];
    const rotated = await rotatePiSession({
      cwd: home,
      sessionsDir,
      name: "main",
      sourcePath,
      seedTokens: 1_000_000,
      recollect: async (q) => {
        queries.push(q);
        return RECALL;
      },
    });
    assert.ok(rotated);
    assert.equal(rotated.recallEntries, 2);
    assert.equal(queries[0].tailStartedAt, "2026-07-18T00:00:01.000Z");
    const objs = parse(readFileSync(rotated.path, "utf-8").trim().split("\n")).slice(1);
    assert.equal(objs.filter((o) => o.customType === RECALL_CUSTOM_TYPE).length, 2);
  });
});

describe("buildSeededPiTranscript — text rate follows the transcript's model", () => {
  const turns = (provider: string, model: string) => {
    const reply = (id: string, parentId: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-18T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "x",
          provider,
          model,
          usage: { totalTokens: 1 },
          stopReason: "stop",
          timestamp: 0,
        },
      });
    return [
      header(),
      userMsg("u1", null, "p".repeat(3500)),
      reply("a1", "u1"),
      userMsg("u2", "a1", "q".repeat(3500)),
      reply("a2", "u2"),
    ].join("\n");
  };

  it("keeps two ~1000-token turns in 2100 for an OpenAI model", () => {
    const res = buildSeededPiTranscript(turns("openai", "gpt-5.5"), {
      cwd: "/home",
      seedTokens: 2100,
    });
    assert.ok(res);
    assert.equal(parse(res.lines)[1].id, "u1");
  });

  it("counts the same turns at claude's denser rate for an Anthropic model", () => {
    const res = buildSeededPiTranscript(turns("anthropic", "claude-opus-5"), {
      cwd: "/home",
      seedTokens: 2100,
    });
    assert.ok(res);
    assert.equal(parse(res.lines)[1].id, "u2");
  });
});

describe("seedPiSession — without a recollection source", () => {
  it("seeds the tail alone when recollect is undefined (recollection disabled)", async () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", convo());
    const seeded = await seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      recollect: undefined,
    });
    assert.ok(seeded);
    assert.equal(seeded.recallEntries, 0);
  });
});

// --- Review follow-ups ---------------------------------------------------------

describe("buildSeededPiTranscript — an OpenAI thinking signature is not its cost", () => {
  it("counts an OpenAI reply's thinking by its text, not its encrypted reasoning item", () => {
    const reply = (id: string, parentId: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-18T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                encrypted_content: "e".repeat(40_000),
              }),
            },
            { type: "text", text: "ok" },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          usage: { totalTokens: 1 },
          stopReason: "stop",
          timestamp: 0,
        },
      });
    const lines = [
      header(),
      userMsg("u1", null, "first"),
      reply("a1", "u1"),
      userMsg("u2", "a1", "second"),
      reply("a2", "u2"),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 1000 });
    assert.ok(res);
    assert.equal(parse(res.lines)[1].id, "u1");
  });
});

describe("buildSeededPiTranscript — the rate follows the model the mind is on", () => {
  const anthropicTurns = () => [
    header(),
    userMsg("u1", null, "p".repeat(3500)),
    assistantMsg("a1", "u1", [{ type: "text", text: "ok" }]),
    userMsg("u2", "a1", "q".repeat(3500)),
    assistantMsg("a2", "u2", [{ type: "text", text: "ok" }]),
  ];

  it("an explicit resume model wins over the transcript's", () => {
    const res = buildSeededPiTranscript(anthropicTurns().join("\n"), {
      cwd: "/home",
      seedTokens: 2100,
      model: "openai/gpt-5.5",
    });
    assert.ok(res);
    assert.equal(parse(res.lines)[1].id, "u1");
  });

  it("a model change after the last reply sets the rate", () => {
    const lines = [
      ...anthropicTurns(),
      JSON.stringify({
        type: "model_change",
        id: "m1",
        parentId: "a2",
        timestamp: "2026-07-18T00:00:04.000Z",
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ];
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 2100 });
    assert.ok(res);
    assert.equal(parse(res.lines)[1].id, "u1");
  });
});
