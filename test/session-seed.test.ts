import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildSeededNote,
  parseArchiveTimestamp,
  SEEDED_SESSION_NOTE_BASE,
} from "../templates/_base/src/lib/seed-note.js";
import {
  buildSeededTranscript,
  findLatestArchivedSession,
  seedSession,
} from "../templates/_base/src/lib/session-seed.js";

// --- Transcript line builders (approximate real SDK jsonl shapes) ---

const OLD = "old-session-0000";

function userPrompt(uuid: string, parentUuid: string | null, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId: OLD,
    message: { role: "user", content: text },
    version: "2.1.210",
  });
}

function assistant(uuid: string, parentUuid: string, blocks: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: OLD,
    message: { role: "assistant", content: blocks },
    version: "2.1.210",
  });
}

/** A user chain event carrying tool_result blocks — a tool-loop continuation, not a boundary. */
function toolResult(uuid: string, parentUuid: string, toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId: OLD,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  });
}

/** A marker line: no uuid, may or may not carry a sessionId. */
function marker(kind: string, withSessionId = true): string {
  return JSON.stringify(
    withSessionId ? { type: kind, sessionId: OLD, value: kind } : { type: kind, value: kind },
  );
}

function parse(lines: string[]): Record<string, any>[] {
  return lines.map((l) => JSON.parse(l));
}

describe("buildSeededTranscript — turn boundaries", () => {
  it("treats a tool_result user event as a continuation, not a turn boundary", () => {
    // Two genuine turns; the second contains a tool_use/tool_result loop.
    const lines = [
      userPrompt("u1", null, "first prompt"),
      assistant("a1", "u1", [{ type: "text", text: "hi" }]),
      userPrompt("u2", "a1", "second prompt"),
      assistant("a2", "u2", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      toolResult("tr1", "a2", "t1"),
      assistant("a3", "tr1", [{ type: "text", text: "done" }]),
    ];
    // Budget large enough for both turns.
    const res = buildSeededTranscript(lines.join("\n"), 1_000_000);
    assert.ok(res);
    // All 6 lines kept — the tool_result did not split the second turn away.
    assert.equal(res.lines.length, 6);
  });

  it("with a tight budget takes only the final turn, and the tool_result stays inside it", () => {
    const turn1 = [
      userPrompt("u1", null, "x".repeat(400)), // ~100 est tokens
      assistant("a1", "u1", [{ type: "text", text: "y".repeat(400) }]),
    ];
    const turn2 = [
      userPrompt("u2", "a1", "second"),
      assistant("a2", "u2", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      toolResult("tr1", "a2", "t1"),
      assistant("a3", "tr1", [{ type: "text", text: "done" }]),
    ];
    const res = buildSeededTranscript([...turn1, ...turn2].join("\n"), 60);
    assert.ok(res);
    // Only turn2's 4 lines survive.
    assert.equal(res.lines.length, 4);
    const objs = parse(res.lines);
    assert.equal(objs[0].message.content, "second");
    // The tool_result line is present within the retained turn.
    assert.ok(objs.some((o) => Array.isArray(o.message?.content)));
  });
});

describe("buildSeededTranscript — token budget selection", () => {
  it("takes as many whole trailing turns as fit in the budget", () => {
    // 3 single-line turns, each ~1000 est tokens (4000 chars / 4); line overhead
    // is negligible against the content, so the boundary is unambiguous.
    const mk = (n: number, parent: string | null) => [
      userPrompt(`u${n}`, parent, "z".repeat(4000)),
    ];
    const lines = [...mk(1, null), ...mk(2, "u1"), ...mk(3, "u2")];
    // Budget fits two turns (~2000) but not three (~3000).
    const res = buildSeededTranscript(lines.join("\n"), 2500);
    assert.ok(res);
    assert.equal(res.lines.length, 2);
    const objs = parse(res.lines);
    assert.equal(objs[0].uuid, "u2");
    assert.equal(objs[1].uuid, "u3");
  });

  it("always keeps at least the final turn even when it alone exceeds the budget", () => {
    const lines = [
      userPrompt("u1", null, "small"),
      userPrompt("u2", "u1", "q".repeat(4000)), // ~1000 est tokens
    ];
    const res = buildSeededTranscript(lines.join("\n"), 10);
    assert.ok(res);
    assert.equal(res.lines.length, 1);
    assert.equal(parse(res.lines)[0].uuid, "u2");
  });
});

describe("buildSeededTranscript — rewrites", () => {
  it("rewrites sessionId on every line that carries one, to a single new id", () => {
    const lines = [
      marker("last-prompt"),
      userPrompt("u1", null, "hello"),
      assistant("a1", "u1", [{ type: "text", text: "hi" }]),
      marker("mode"),
    ];
    const res = buildSeededTranscript(lines.join("\n"), 1_000_000);
    assert.ok(res);
    const objs = parse(res.lines);
    const ids = new Set(objs.filter((o) => "sessionId" in o).map((o) => o.sessionId));
    assert.equal(ids.size, 1);
    const [newId] = [...ids];
    assert.equal(newId, res.sessionId);
    assert.notEqual(newId, OLD);
    // Every line that had a sessionId now has the new one.
    for (const o of objs) {
      if ("sessionId" in o) assert.equal(o.sessionId, newId);
    }
  });

  it("nulls only the first chain event's parentUuid, leaving later ones intact", () => {
    const lines = [
      userPrompt("u1", null, "first"),
      assistant("a1", "u1", [{ type: "text", text: "hi" }]),
      userPrompt("u2", "a1", "second"),
      assistant("a2", "u2", [{ type: "text", text: "bye" }]),
    ];
    // Tight budget so the tail starts at u2 (a real parentUuid = "a1").
    const res = buildSeededTranscript(lines.join("\n"), 40);
    assert.ok(res);
    const objs = parse(res.lines);
    assert.equal(objs[0].uuid, "u2");
    assert.equal(objs[0].parentUuid, null); // detached from dropped history
    assert.equal(objs[1].uuid, "a2");
    assert.equal(objs[1].parentUuid, "u2"); // internal link preserved
  });

  it("preserves marker lines and content blocks verbatim (only ids change)", () => {
    // The marker sits inside the turn (after the boundary) so it's part of the tail.
    const lines = [
      userPrompt("u1", null, "hello"),
      marker("queue-operation", false), // no sessionId
      assistant("a1", "u1", [
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "volute chat send #x hi" } },
      ]),
      toolResult("tr1", "a1", "t1"),
    ];
    const res = buildSeededTranscript(lines.join("\n"), 1_000_000);
    assert.ok(res);
    const objs = parse(res.lines);
    assert.equal(objs.length, 4);
    // Marker without sessionId is untouched.
    assert.deepEqual(objs[1], { type: "queue-operation", value: "queue-operation" });
    // Thinking + tool_use content survive intact.
    assert.deepEqual(objs[2].message.content[0], { type: "thinking", thinking: "hmm" });
    assert.deepEqual(objs[2].message.content[1], {
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "volute chat send #x hi" },
    });
    // The mind-channel send in the tool_use is preserved verbatim.
    assert.equal(objs[2].message.content[1].input.command, "volute chat send #x hi");
  });
});

describe("buildSeededTranscript — degenerate inputs", () => {
  it("returns null for an empty transcript", () => {
    assert.equal(buildSeededTranscript("", 30000), null);
    assert.equal(buildSeededTranscript("\n\n  \n", 30000), null);
  });

  it("returns null when there are no genuine turns (only markers / tool results)", () => {
    const lines = [marker("mode"), toolResult("tr1", "a0", "t0")];
    assert.equal(buildSeededTranscript(lines.join("\n"), 30000), null);
  });

  it("returns null on a corrupt (unparseable) line", () => {
    const lines = [userPrompt("u1", null, "hi"), "{not valid json", assistant("a1", "u1", [])];
    assert.equal(buildSeededTranscript(lines.join("\n"), 30000), null);
  });
});

// --- findLatestArchivedSession ---

describe("findLatestArchivedSession", () => {
  function scratch(): string {
    return mkdtempSync(resolve(tmpdir(), "seed-archive-"));
  }

  it("returns null when the archive dir is missing", () => {
    assert.equal(findLatestArchivedSession(scratch(), "main"), null);
  });

  it("returns the newest pointer's session id and archived-at by timestamp suffix", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: "old" }),
    );
    writeFileSync(
      resolve(archive, "main-2026-07-18T14-30.json"),
      JSON.stringify({ sessionId: "new" }),
    );
    writeFileSync(
      resolve(archive, "main-2026-07-17T23-59.json"),
      JSON.stringify({ sessionId: "older" }),
    );
    const found = findLatestArchivedSession(dir, "main");
    assert.equal(found?.sessionId, "new");
    // Timestamp is parsed as UTC minute-precision.
    assert.equal(found?.archivedAt, Date.UTC(2026, 6, 18, 14, 30));
  });

  it("does not confuse `main` with a differently-named `main-thread` session", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: "main-id" }),
    );
    writeFileSync(
      resolve(archive, "main-thread-2026-07-18T14-30.json"),
      JSON.stringify({ sessionId: "thread-id" }),
    );
    assert.equal(findLatestArchivedSession(dir, "main")?.sessionId, "main-id");
    assert.equal(findLatestArchivedSession(dir, "main-thread")?.sessionId, "thread-id");
  });

  it("returns null when no pointer matches the name", () => {
    const dir = scratch();
    mkdirSync(resolve(dir, "archive"), { recursive: true });
    writeFileSync(
      resolve(dir, "archive", "other-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: "x" }),
    );
    assert.equal(findLatestArchivedSession(dir, "main"), null);
  });

  it("returns null when the pointer file is invalid JSON or lacks sessionId", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(resolve(archive, "main-2026-07-18T10-00.json"), "{bad json");
    assert.equal(findLatestArchivedSession(dir, "main"), null);

    const dir2 = scratch();
    const archive2 = resolve(dir2, "archive");
    mkdirSync(archive2, { recursive: true });
    writeFileSync(resolve(archive2, "main-2026-07-18T10-00.json"), JSON.stringify({ foo: 1 }));
    assert.equal(findLatestArchivedSession(dir2, "main"), null);
  });
});

// --- seed-note: gap formatting ---

describe("buildSeededNote / parseArchiveTimestamp", () => {
  it("parses the UTC minute-precision archive timestamp", () => {
    assert.equal(parseArchiveTimestamp("2026-07-18T14-30"), Date.UTC(2026, 6, 18, 14, 30));
    assert.equal(parseArchiveTimestamp("not-a-timestamp"), null);
    assert.equal(parseArchiveTimestamp("2026-07-18T14-30-00"), null); // has seconds → no match
  });

  it("returns the base note unchanged when the archived-at is unknown", () => {
    assert.equal(buildSeededNote(null), SEEDED_SESSION_NOTE_BASE);
  });

  it("adds a coarse gap clause in minutes / hours / days", () => {
    const base = Date.UTC(2026, 6, 18, 12, 0);
    assert.match(buildSeededNote(base, base + 6 * 3_600_000), /the break lasted about 6 hours\)/);
    assert.match(buildSeededNote(base, base + 45 * 60_000), /the break lasted about 45 minutes\)/);
    assert.match(buildSeededNote(base, base + 2 * 86_400_000), /the break lasted about 2 days\)/);
    // Singular forms.
    assert.match(buildSeededNote(base, base + 60 * 60_000), /about 1 hour\)/);
    // Sub-minute gap.
    assert.match(buildSeededNote(base, base + 5_000), /the break lasted less than a minute\)/);
    // The rest of the note text is preserved.
    assert.match(buildSeededNote(base, base + 3_600_000), /a fresh session begins here\.$/);
  });

  it("falls back to the base note for a negative (clock-skew) gap", () => {
    const base = Date.UTC(2026, 6, 18, 12, 0);
    assert.equal(buildSeededNote(base, base - 60_000), SEEDED_SESSION_NOTE_BASE);
  });
});

// --- seedSession (end-to-end file wiring) ---

describe("seedSession", () => {
  /**
   * Build a mind-like layout: a home dir whose SDK project dir holds the old
   * transcript, and a sessions dir with an archived pointer to it.
   * findClaudeSessionFile scans `<cwd>/.claude/projects/*`.
   */
  function setup(oldId: string, transcript: string) {
    const root = mkdtempSync(resolve(tmpdir(), "seed-session-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${oldId}.jsonl`), transcript);
    const sessionsDir = resolve(root, ".mind", "sessions");
    const archive = resolve(sessionsDir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: oldId }),
    );
    return { home, sessionsDir, projectDir };
  }

  const transcript = [
    userPrompt("u1", null, "hello"),
    assistant("a1", "u1", [{ type: "text", text: "hi there" }]),
  ].join("\n");

  it("seeds a fresh persistent session: writes a synthetic transcript and returns its id + archived-at", () => {
    const { home, sessionsDir, projectDir } = setup(OLD, transcript);
    const seeded = seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 });
    assert.ok(seeded);
    assert.notEqual(seeded.sessionId, OLD);
    // The archived-at parsed from the pointer filename (`main-2026-07-18T10-00.json`).
    assert.equal(seeded.archivedAt, Date.UTC(2026, 6, 18, 10, 0));
    const written = readFileSync(resolve(projectDir, `${seeded.sessionId}.jsonl`), "utf-8");
    const objs = written
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(objs.length, 2);
    assert.equal(objs[0].sessionId, seeded.sessionId);
    assert.equal(objs[0].parentUuid, null);
    assert.equal(objs[0].message.content, "hello");
  });

  it("returns null when seedTokens is 0 (disabled)", () => {
    const { home, sessionsDir } = setup(OLD, transcript);
    assert.equal(seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 0 }), null);
  });

  it("returns null for an ephemeral new-* session", () => {
    const { home, sessionsDir } = setup(OLD, transcript);
    assert.equal(seedSession({ cwd: home, sessionsDir, name: "new-abc", seedTokens: 30000 }), null);
  });

  it("returns null when there is no archived pointer", () => {
    const root = mkdtempSync(resolve(tmpdir(), "seed-none-"));
    const home = resolve(root, "home");
    mkdirSync(home, { recursive: true });
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    assert.equal(seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 }), null);
  });

  it("returns null when the archived transcript jsonl no longer exists", () => {
    // Pointer present, but the jsonl file was never written (didn't survive).
    const root = mkdtempSync(resolve(tmpdir(), "seed-orphan-"));
    const home = resolve(root, "home");
    mkdirSync(resolve(home, ".claude", "projects", "proj"), { recursive: true });
    const sessionsDir = resolve(root, ".mind", "sessions");
    const archive = resolve(sessionsDir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: "missing-id" }),
    );
    assert.equal(seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 }), null);
  });
});
