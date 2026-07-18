import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildSeededRollout,
  findLatestArchivedThreadId,
  generateThreadId,
  seedCodexSession,
} from "../templates/_base/src/lib/codex-session-seed.js";

// --- Rollout line builders (approximate real Codex rollout shapes) ---

const OLD = "019f5e60-86f5-7770-80fa-6e9eadf58c24";

function sessionMeta(id: string): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:06:52.000Z",
    type: "session_meta",
    payload: {
      session_id: id,
      id,
      parent_thread_id: "019f-parent-thread",
      timestamp: "2026-07-13T22:06:52.000Z",
      cwd: "/minds/x/home",
      originator: "codex_sdk_ts",
      cli_version: "0.144.3",
      history_mode: "legacy",
    },
  });
}

function message(role: string, text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:00.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

function toolCall(callId: string, input = "tools.exec_command({})"): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:01.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      id: `ctc_${callId}`,
      status: "completed",
      call_id: callId,
      name: "exec",
      input,
    },
  });
}

function toolOutput(callId: string): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:02.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [{ type: "input_text", text: "ok" }],
    },
  });
}

function reasoning(): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:03.000Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      id: "rs_abc",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "gAAAAAB-opaque-provider-bound-blob",
    },
  });
}

function eventMsg(kind: string): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:04.000Z",
    type: "event_msg",
    payload: { type: kind },
  });
}

function turnContext(): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:05.000Z",
    type: "turn_context",
    payload: { turn_id: "t1", model: "gpt-5.6-terra", cwd: "/minds/x/home" },
  });
}

function worldState(): string {
  return JSON.stringify({
    timestamp: "2026-07-13T22:07:06.000Z",
    type: "world_state",
    payload: {},
  });
}

function parseLines(lines: string[]): Record<string, any>[] {
  return lines.map((l) => JSON.parse(l));
}

const NEW = "019f8000-1111-7abc-8def-0123456789ab";
const NOW = new Date("2026-07-18T16:30:25.000Z");

describe("buildSeededRollout — session_meta rewrite", () => {
  it("rewrites id/session_id/timestamp and drops parent_thread_id", () => {
    const jsonl = [sessionMeta(OLD), message("user", "hi")].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 30000, NOW);
    assert.ok(res);
    const objs = parseLines(res.lines);
    const meta = objs[0];
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.payload.session_id, NEW);
    assert.equal(meta.payload.id, NEW);
    assert.equal("parent_thread_id" in meta.payload, false);
    assert.equal(meta.payload.timestamp, NOW.toISOString());
    assert.equal(meta.timestamp, NOW.toISOString());
    // Non-identity fields are preserved.
    assert.equal(meta.payload.history_mode, "legacy");
    assert.equal(meta.payload.originator, "codex_sdk_ts");
  });

  it("returns the fresh thread id it was given", () => {
    const res = buildSeededRollout(
      [sessionMeta(OLD), message("user", "hi")].join("\n"),
      NEW,
      30000,
    );
    assert.ok(res);
    assert.equal(res.threadId, NEW);
  });
});

describe("buildSeededRollout — line filtering", () => {
  it("drops reasoning, event_msg, turn_context, world_state; keeps messages and tool pairs", () => {
    const jsonl = [
      sessionMeta(OLD),
      eventMsg("task_started"),
      message("developer", "sdk instructions"),
      turnContext(),
      message("user", "the prompt"),
      eventMsg("user_message"),
      reasoning(),
      toolCall("call_1"),
      toolOutput("call_1"),
      eventMsg("token_count"),
      worldState(),
      message("assistant", "the reply"),
      eventMsg("task_complete"),
    ].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 1_000_000, NOW);
    assert.ok(res);
    const objs = parseLines(res.lines);
    const types = objs.map((o) => o.payload?.type ?? o.type);
    // No opaque / telemetry / turn-context / world-state lines survive.
    assert.equal(
      objs.some((o) => o.type === "event_msg"),
      false,
    );
    assert.equal(
      objs.some((o) => o.type === "turn_context"),
      false,
    );
    assert.equal(
      objs.some((o) => o.type === "world_state"),
      false,
    );
    assert.equal(
      objs.some((o) => o.payload?.type === "reasoning"),
      false,
    );
    // session_meta + user msg + tool call + tool output + assistant msg. The
    // leading developer message precedes the first user turn boundary, so it's
    // dropped with everything before the retained tail (the SDK re-injects its
    // own instruction preamble on resume).
    assert.deepEqual(types, [
      "session_meta",
      "message",
      "custom_tool_call",
      "custom_tool_call_output",
      "message",
    ]);
    // The encrypted reasoning blob is gone entirely.
    assert.equal(res.lines.join("\n").includes("opaque-provider-bound"), false);
  });

  it("keeps message content verbatim", () => {
    const jsonl = [sessionMeta(OLD), message("user", 'volute chat send #x "hi"')].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 30000, NOW);
    assert.ok(res);
    assert.equal(parseLines(res.lines)[1].payload.content[0].text, 'volute chat send #x "hi"');
  });
});

describe("buildSeededRollout — tool-call pairing", () => {
  it("drops an orphaned trailing tool call (no matching output)", () => {
    const jsonl = [
      sessionMeta(OLD),
      message("user", "prompt"),
      toolCall("call_1"),
      toolOutput("call_1"),
      toolCall("call_2"), // truncated turn — no output
    ].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 1_000_000, NOW);
    assert.ok(res);
    const objs = parseLines(res.lines);
    const callIds = objs
      .filter((o) => o.payload?.type === "custom_tool_call")
      .map((o) => o.payload.call_id);
    assert.deepEqual(callIds, ["call_1"]);
    // No custom_tool_call or output ever appears without its partner.
    assert.equal(
      objs.some((o) => o.payload?.call_id === "call_2"),
      false,
    );
  });

  it("drops an orphaned tool output (no matching call)", () => {
    const jsonl = [
      sessionMeta(OLD),
      message("user", "prompt"),
      toolOutput("call_x"), // output whose call isn't present
      toolCall("call_1"),
      toolOutput("call_1"),
    ].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 1_000_000, NOW);
    assert.ok(res);
    const objs = parseLines(res.lines);
    assert.equal(
      objs.some((o) => o.payload?.call_id === "call_x"),
      false,
    );
    assert.equal(objs.filter((o) => o.payload?.type === "custom_tool_call_output").length, 1);
  });
});

describe("buildSeededRollout — budget selection", () => {
  // Each turn is one user message padded to ~1000 est tokens (4000 chars / 4).
  const turn = (n: number) => message("user", `${n}:${"z".repeat(4000)}`);

  it("takes as many whole trailing turns as fit in the budget", () => {
    const jsonl = [sessionMeta(OLD), turn(1), turn(2), turn(3)].join("\n");
    // Budget fits two turns (~2000) but not three (~3000).
    const res = buildSeededRollout(jsonl, NEW, 2500, NOW);
    assert.ok(res);
    const msgs = parseLines(res.lines).filter((o) => o.payload?.type === "message");
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].payload.content[0].text.startsWith("2:"));
    assert.ok(msgs[1].payload.content[0].text.startsWith("3:"));
  });

  it("always keeps at least the final turn even when it alone exceeds the budget", () => {
    const jsonl = [sessionMeta(OLD), message("user", "small"), turn(2)].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 10, NOW);
    assert.ok(res);
    const msgs = parseLines(res.lines).filter((o) => o.payload?.type === "message");
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].payload.content[0].text.startsWith("2:"));
  });

  it("keeps a complete tool pair inside the retained final turn", () => {
    const jsonl = [
      sessionMeta(OLD),
      turn(1),
      message("user", "second"),
      toolCall("call_1"),
      toolOutput("call_1"),
      message("assistant", "done"),
    ].join("\n");
    const res = buildSeededRollout(jsonl, NEW, 60, NOW);
    assert.ok(res);
    const objs = parseLines(res.lines);
    // Only the final turn's lines survive (meta + user + call + output + assistant).
    assert.equal(objs.length, 5);
    assert.equal(objs[1].payload.content[0].text, "second");
    assert.equal(objs[2].payload.call_id, "call_1");
    assert.equal(objs[3].payload.call_id, "call_1");
  });
});

describe("buildSeededRollout — degenerate inputs", () => {
  it("returns null for an empty transcript", () => {
    assert.equal(buildSeededRollout("", NEW, 30000), null);
    assert.equal(buildSeededRollout("\n\n  \n", NEW, 30000), null);
  });

  it("returns null when the first line is not session_meta", () => {
    assert.equal(buildSeededRollout([message("user", "hi")].join("\n"), NEW, 30000), null);
  });

  it("returns null when there is no user-message turn boundary", () => {
    const jsonl = [sessionMeta(OLD), message("developer", "x"), reasoning()].join("\n");
    assert.equal(buildSeededRollout(jsonl, NEW, 30000), null);
  });

  it("returns null on a corrupt (unparseable) body line", () => {
    const jsonl = [sessionMeta(OLD), message("user", "hi"), "{not json"].join("\n");
    assert.equal(buildSeededRollout(jsonl, NEW, 30000), null);
  });
});

describe("generateThreadId", () => {
  it("produces a v7 UUID string with the codex millisecond-timestamp prefix", () => {
    const id = generateThreadId(NOW);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // First 48 bits are the millisecond timestamp — deterministic prefix.
    const hexTs = NOW.getTime().toString(16).padStart(12, "0");
    assert.equal(id.replace(/-/g, "").slice(0, 12), hexTs);
  });

  it("is unique across calls", () => {
    assert.notEqual(generateThreadId(NOW), generateThreadId(NOW));
  });
});

describe("findLatestArchivedThreadId", () => {
  function scratch(): string {
    return mkdtempSync(resolve(tmpdir(), "codex-seed-archive-"));
  }

  it("returns null when the archive dir is missing", () => {
    assert.equal(findLatestArchivedThreadId(scratch(), "main"), null);
  });

  it("returns the newest pointer's threadId by timestamp suffix", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ threadId: "old" }),
    );
    writeFileSync(
      resolve(archive, "main-2026-07-18T14-30.json"),
      JSON.stringify({ threadId: "new" }),
    );
    writeFileSync(
      resolve(archive, "main-2026-07-17T23-59.json"),
      JSON.stringify({ threadId: "older" }),
    );
    assert.equal(findLatestArchivedThreadId(dir, "main"), "new");
  });

  it("does not confuse `main` with a differently-named session", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ threadId: "m" }),
    );
    writeFileSync(
      resolve(archive, "@suzy-2026-07-18T14-30.json"),
      JSON.stringify({ threadId: "s" }),
    );
    assert.equal(findLatestArchivedThreadId(dir, "main"), "m");
    assert.equal(findLatestArchivedThreadId(dir, "@suzy"), "s");
  });

  it("returns null when the pointer is invalid JSON or lacks threadId", () => {
    const dir = scratch();
    const archive = resolve(dir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(resolve(archive, "main-2026-07-18T10-00.json"), "{bad");
    assert.equal(findLatestArchivedThreadId(dir, "main"), null);

    const dir2 = scratch();
    const archive2 = resolve(dir2, "archive");
    mkdirSync(archive2, { recursive: true });
    writeFileSync(
      resolve(archive2, "main-2026-07-18T10-00.json"),
      JSON.stringify({ sessionId: "x" }),
    );
    assert.equal(findLatestArchivedThreadId(dir2, "main"), null);
  });
});

describe("seedCodexSession", () => {
  /**
   * Build a mind-like layout: an archived codex pointer to OLD and the old
   * rollout under .mind/codex/sessions/YYYY/MM/DD/ where findCodexSessionFile
   * scans for a filename containing the thread id.
   */
  function setup(oldId: string, rolloutLines: string[]) {
    const mindDir = mkdtempSync(resolve(tmpdir(), "codex-seed-mind-"));
    const archive = resolve(mindDir, ".mind", "codex-sessions", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ threadId: oldId }),
    );
    const rolloutDir = resolve(mindDir, ".mind", "codex", "sessions", "2026", "07", "13");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      resolve(rolloutDir, `rollout-2026-07-13T22-06-52-${oldId}.jsonl`),
      `${rolloutLines.join("\n")}\n`,
    );
    return mindDir;
  }

  const rollout = [sessionMeta(OLD), message("user", "hello"), message("assistant", "hi there")];

  it("seeds a fresh persistent session: writes a rollout under today's date and returns its id", () => {
    const mindDir = setup(OLD, rollout);
    const newId = seedCodexSession({ mindDir, name: "main", seedTokens: 30000, now: NOW });
    assert.ok(newId);
    assert.notEqual(newId, OLD);
    // Written under .mind/codex/sessions/2026/07/18/ (NOW's local date) with the
    // rollout-<ts>-<threadId>.jsonl name Codex uses.
    const y = String(NOW.getFullYear());
    const mo = String(NOW.getMonth() + 1).padStart(2, "0");
    const d = String(NOW.getDate()).padStart(2, "0");
    const dayDir = resolve(mindDir, ".mind", "codex", "sessions", y, mo, d);
    const files = readdirSync(dayDir);
    assert.equal(files.length, 1);
    assert.match(
      files[0],
      new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${newId}\\.jsonl$`),
    );
    const objs = parseLines(readFileSync(resolve(dayDir, files[0]), "utf-8").trim().split("\n"));
    assert.equal(objs[0].payload.session_id, newId);
    assert.equal(objs[1].payload.content[0].text, "hello");
  });

  it("returns null when seedTokens is 0 (disabled)", () => {
    const mindDir = setup(OLD, rollout);
    assert.equal(seedCodexSession({ mindDir, name: "main", seedTokens: 0, now: NOW }), null);
  });

  it("returns null for an ephemeral new-* session", () => {
    const mindDir = setup(OLD, rollout);
    assert.equal(seedCodexSession({ mindDir, name: "new-abc", seedTokens: 30000, now: NOW }), null);
  });

  it("returns null when there is no archived pointer", () => {
    const mindDir = mkdtempSync(resolve(tmpdir(), "codex-seed-none-"));
    mkdirSync(resolve(mindDir, ".mind", "codex-sessions"), { recursive: true });
    assert.equal(seedCodexSession({ mindDir, name: "main", seedTokens: 30000, now: NOW }), null);
  });

  it("returns null when the archived rollout no longer exists", () => {
    const mindDir = mkdtempSync(resolve(tmpdir(), "codex-seed-orphan-"));
    const archive = resolve(mindDir, ".mind", "codex-sessions", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ threadId: "019f-missing" }),
    );
    assert.equal(seedCodexSession({ mindDir, name: "main", seedTokens: 30000, now: NOW }), null);
  });

  it("writes the seed into the source rollout's sessions root (~/.codex case)", () => {
    // When CODEX_HOME is unset, Codex reads/writes rollouts under ~/.codex/sessions,
    // so findCodexSessionFile locates the old rollout there — the seed must land in
    // that same root, not under mindDir/.mind/codex/sessions.
    const home = mkdtempSync(resolve(tmpdir(), "codex-seed-home-"));
    const mindDir = mkdtempSync(resolve(tmpdir(), "codex-seed-mind2-"));
    const archive = resolve(mindDir, ".mind", "codex-sessions", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      resolve(archive, "main-2026-07-18T10-00.json"),
      JSON.stringify({ threadId: OLD }),
    );
    const homeRollout = resolve(home, ".codex", "sessions", "2026", "07", "13");
    mkdirSync(homeRollout, { recursive: true });
    writeFileSync(
      resolve(homeRollout, `rollout-2026-07-13T22-06-52-${OLD}.jsonl`),
      `${rollout.join("\n")}\n`,
    );

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    let newId: string | null;
    try {
      newId = seedCodexSession({ mindDir, name: "main", seedTokens: 30000, now: NOW });
    } finally {
      process.env.HOME = prevHome;
    }
    assert.ok(newId);
    // Seed lands under ~/.codex/sessions/<today>, where Codex resume will find it —
    // and NOT under mindDir/.mind/codex/sessions.
    const y = String(NOW.getFullYear());
    const mo = String(NOW.getMonth() + 1).padStart(2, "0");
    const d = String(NOW.getDate()).padStart(2, "0");
    const homeDayDir = resolve(home, ".codex", "sessions", y, mo, d);
    assert.equal(readdirSync(homeDayDir).length, 1);
    assert.equal(existsSync(resolve(mindDir, ".mind", "codex", "sessions", y, mo, d)), false);
  });
});
