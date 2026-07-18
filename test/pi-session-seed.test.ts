import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildSeededPiTranscript,
  findLatestArchivedPiSessionDir,
  hasLivePiSession,
  seedPiSession,
} from "../templates/_base/src/lib/pi-session-seed.js";

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
    const big = "z".repeat(4000); // ~1000 est tokens per turn
    const lines = [
      header(),
      userMsg("u1", null, big),
      userMsg("u2", "u1", big),
      userMsg("u3", "u2", big),
    ];
    // Budget fits two turns (~2000) but not three (~3000).
    const res = buildSeededPiTranscript(lines.join("\n"), { cwd: "/home", seedTokens: 2500 });
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

describe("findLatestArchivedPiSessionDir", () => {
  it("returns null when there is no archive dir", () => {
    const base = scratch();
    assert.equal(findLatestArchivedPiSessionDir(resolve(base, ".mind/pi-sessions"), "main"), null);
  });

  it("picks the newest archived dir for the exact session name", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T00-00", [header(), userMsg("u1", null, "a")]);
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [header(), userMsg("u1", null, "b")]);
    const found = findLatestArchivedPiSessionDir(piSessionsDir, "main");
    assert.ok(found);
    assert.match(found, /main-2026-07-18T09-30$/);
  });

  it("disambiguates `main` from `main-thread`", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T00-00", [header(), userMsg("u1", null, "a")]);
    makeArchive(piSessionsDir, "main-thread", "2026-07-18T09-30", [
      header(),
      userMsg("u1", null, "b"),
    ]);
    const main = findLatestArchivedPiSessionDir(piSessionsDir, "main");
    assert.ok(main);
    assert.match(main, /\/main-2026-07-18T00-00$/);
    const thread = findLatestArchivedPiSessionDir(piSessionsDir, "main-thread");
    assert.ok(thread);
    assert.match(thread, /main-thread-2026-07-18T09-30$/);
  });

  it("ignores dirs whose suffix is not a valid timestamp", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "not-a-timestamp", [header(), userMsg("u1", null, "a")]);
    assert.equal(findLatestArchivedPiSessionDir(piSessionsDir, "main"), null);
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

  it("writes a seed file into a fresh live dir and returns the new session id", () => {
    const home = resolve(scratch(), "home");
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());

    const id = seedPiSession({ cwd: home, piSessionsDir, name: "main", seedTokens: 1_000_000 });
    assert.ok(id);

    const liveDir = resolve(piSessionsDir, "main");
    const files = readdirSync(liveDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const written = readFileSync(resolve(liveDir, files[0]), "utf-8").trim().split("\n");
    const h = JSON.parse(written[0]);
    assert.equal(h.id, id);
    assert.equal(h.cwd, resolve(home));
  });

  it("returns null when there is no archive", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    assert.equal(
      seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null when the archive dir has no jsonl", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    mkdirSync(resolve(piSessionsDir, "archive", "main-2026-07-18T09-30"), { recursive: true });
    assert.equal(
      seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("returns null on a corrupt source transcript", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [header(), "{bad json"]);
    assert.equal(
      seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });

  it("never seeds an ephemeral new-* session", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "new-abc", "2026-07-18T09-30", transcript());
    assert.equal(
      seedPiSession({ cwd: "/home", piSessionsDir, name: "new-abc", seedTokens: 1000 }),
      null,
    );
  });

  it("is disabled when seedTokens is 0", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());
    assert.equal(seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 0 }), null);
  });

  it("does not seed over an existing live session", () => {
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", transcript());
    const liveDir = resolve(piSessionsDir, "main");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(resolve(liveDir, "existing.jsonl"), `${header("live-id")}\n`);
    assert.equal(
      seedPiSession({ cwd: "/home", piSessionsDir, name: "main", seedTokens: 1000 }),
      null,
    );
  });
});

// --- Load-bearing: the real SessionManager resumes the seed ----------------

describe("seedPiSession + SessionManager.continueRecent (real SDK)", () => {
  it("continueRecent adopts the seeded file and exposes the prior conversation", () => {
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

    const seededId = seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
    });
    assert.ok(seededId);

    // Exactly as agent.ts calls it: cwd = home dir, sessionDir = <base>/<name>.
    const sm = SessionManager.continueRecent(home, resolve(piSessionsDir, "main"));
    // The SDK adopted our seed: its header id is the one we generated.
    assert.equal(sm.getSessionId(), seededId);

    // The prior conversation is present in the resumed context.
    const { messages } = sm.buildSessionContext();
    const texts = JSON.stringify(messages);
    assert.ok(messages.length >= 4);
    assert.match(texts, /first prompt/);
    assert.match(texts, /all done/);
  });

  it("does NOT adopt the seed when the header cwd doesn't match (cwd rewrite is load-bearing)", () => {
    const home = resolve(scratch(), "home");
    mkdirSync(home, { recursive: true });
    const piSessionsDir = resolve(scratch(), ".mind/pi-sessions");
    makeArchive(piSessionsDir, "main", "2026-07-18T09-30", [
      header(SRC_ID, "/orig/home"),
      userMsg("u1", null, "hi"),
      assistantMsg("a1", "u1", [{ type: "text", text: "yo" }]),
    ]);
    const seededId = seedPiSession({
      cwd: home,
      piSessionsDir,
      name: "main",
      seedTokens: 1_000_000,
    });
    assert.ok(seededId);

    // Resume with a DIFFERENT cwd than the seed header records: the SDK's cwd
    // filter rejects the file and mints a fresh session instead.
    const sm = SessionManager.continueRecent(
      resolve(home, "elsewhere"),
      resolve(piSessionsDir, "main"),
    );
    assert.notEqual(sm.getSessionId(), seededId);
  });
});
