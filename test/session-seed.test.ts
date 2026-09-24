import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildSeededNote,
  COLD_SESSION_NOTE_BASE,
  parseArchiveTimestamp,
  RECALL_NOTE_SUFFIX,
  ROTATED_SESSION_NOTE,
  SEEDED_SESSION_NOTE_BASE,
} from "../templates/_base/src/lib/seed-note.js";
import {
  archivePointerTimestamp,
  buildSeededTranscript,
  capRecollection,
  DEFAULT_SEED_TOKENS,
  estimateLineTokens,
  findLatestArchivedSession,
  RECALL_PREAMBLE,
  type RecallEntry,
  type RecollectionQuery,
  recallLabel,
  rotateSession,
  seedSession,
  TAIL_ONLY_SEED_TOKENS,
  TRIMMED_TURN_MARKER,
  writeRotationArchivePointer,
} from "../templates/_base/src/lib/session-seed.js";

// --- Transcript line builders (approximate real SDK jsonl shapes) ---

const OLD = "old-session-0000";

function userPrompt(
  uuid: string,
  parentUuid: string | null,
  text: string,
  timestamp = "2026-07-19T12:00:00.000Z",
): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId: OLD,
    timestamp,
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
    // 3 single-line turns, each ~1000 est tokens (2000 chars at ~2 chars/token).
    const mk = (n: number, parent: string | null) => [
      userPrompt(`u${n}`, parent, "z".repeat(2000)),
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

// --- Over-budget final turn (the rotation case: the turn that crossed the limit) ---

/** One content-block line of an assistant message (the SDK writes one line per block). */
function asstLine(uuid: string, parentUuid: string, msgId: string, block: unknown): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: OLD,
    message: { id: msgId, role: "assistant", content: [block] },
  });
}

/** A tool_result line with sizeable output, plus the SDK's duplicate toolUseResult copy. */
function bigResult(uuid: string, parentUuid: string, toolUseId: string, chars: number): string {
  const out = "r".repeat(chars);
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId: OLD,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: out }],
    },
    toolUseResult: { stdout: out },
  });
}

/** A single prompt followed by `steps` tool-loop steps, each ~`stepChars/2` est tokens. */
function toolLoopTurn(steps: number, stepChars: number): string[] {
  const lines = [
    userPrompt("p", null, "please do the long thing"),
    JSON.stringify({
      type: "attachment",
      uuid: "att",
      parentUuid: "p",
      sessionId: OLD,
      attachment: { type: "hook_additional_context", content: ["context"] },
    }),
  ];
  let parent = "att";
  for (let s = 0; s < steps; s++) {
    lines.push(
      asstLine(`a${s}`, parent, `m${s}`, {
        type: "tool_use",
        id: `t${s}`,
        name: "Bash",
        input: { command: `step ${s}` },
      }),
    );
    lines.push(bigResult(`r${s}`, `a${s}`, `t${s}`, stepChars));
    parent = `r${s}`;
  }
  lines.push(asstLine("final", parent, "mfinal", { type: "text", text: "all done" }));
  return lines;
}

/** Structural invariants a resumable transcript must hold. */
function assertResumable(objs: Record<string, any>[]) {
  const uuids = new Set(objs.map((o) => o.uuid).filter(Boolean));
  const uses = new Set<string>();
  const results: string[] = [];
  for (const o of objs) {
    if (o.parentUuid != null) assert.ok(uuids.has(o.parentUuid), `dangling parent ${o.parentUuid}`);
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b.type === "tool_use") uses.add(b.id);
      if (b.type === "tool_result") results.push(b.tool_use_id);
    }
  }
  for (const r of results) assert.ok(uses.has(r), `orphaned tool_result ${r}`);
  assert.equal(objs.filter((o) => o.uuid && o.parentUuid === null).length, 1, "one chain root");
}

const estimate = (objs: Record<string, any>[]) =>
  objs.reduce((a, o) => a + estimateLineTokens(o), 0);

describe("buildSeededTranscript — over-budget final turn", () => {
  it("trims inside the turn to fit the budget: prompt + marker, then the latest whole steps", () => {
    // 40 steps × ~1000 est tokens ≈ 40k — one turn, far over a 10k budget.
    const lines = toolLoopTurn(40, 2000);
    const res = buildSeededTranscript(lines.join("\n"), 10_000);
    assert.ok(res);
    const objs = parse(res.lines);

    const total = estimate(objs);
    assert.ok(total <= 10_000, `seed estimate ${total} exceeds the 10k budget`);
    assert.ok(total >= 8_000, `seed estimate ${total} wastes the budget`);

    // Opening prompt section survives, the prompt now carrying the trim marker.
    assert.equal(objs[0].uuid, "p");
    assert.equal(objs[0].parentUuid, null);
    assert.deepEqual(objs[0].message.content, [
      { type: "text", text: "please do the long thing" },
      { type: "text", text: TRIMMED_TURN_MARKER },
    ]);
    assert.equal(objs[1].uuid, "att");
    // The kept steps resume at an assistant line re-parented onto the prompt section.
    assert.equal(objs[2].type, "assistant");
    assert.equal(objs[2].parentUuid, "att");
    assert.equal(objs.at(-1).uuid, "final");
    assertResumable(objs);
  });

  it("keeps the prompt and the final step when even one step exceeds the budget", () => {
    const res = buildSeededTranscript(toolLoopTurn(5, 20_000).join("\n"), 1_000);
    assert.ok(res);
    const objs = parse(res.lines);
    assert.deepEqual(
      objs.map((o) => o.uuid),
      ["p", "att", "final"],
    );
    assert.equal(objs[2].parentUuid, "att");
    assertResumable(objs);
  });

  it("never cuts between a message's tool_use lines and their parallel results", () => {
    // Step s: one assistant message split over two lines (two parallel tool_uses),
    // then both results. Resuming at the second line of the message, or after only
    // one result, would orphan a tool_result.
    const lines = [userPrompt("p", null, "go")];
    let parent = "p";
    for (let s = 0; s < 10; s++) {
      lines.push(
        asstLine(`a${s}x`, parent, `m${s}`, {
          type: "tool_use",
          id: `t${s}x`,
          name: "Bash",
          input: {},
        }),
      );
      lines.push(
        asstLine(`a${s}y`, `a${s}x`, `m${s}`, {
          type: "tool_use",
          id: `t${s}y`,
          name: "Bash",
          input: {},
        }),
      );
      lines.push(bigResult(`r${s}x`, `a${s}y`, `t${s}x`, 1000));
      lines.push(bigResult(`r${s}y`, `r${s}x`, `t${s}y`, 1000));
      parent = `r${s}y`;
    }
    // Budgets that land on every alignment within a step.
    for (let budget = 900; budget <= 4000; budget += 137) {
      const res = buildSeededTranscript(lines.join("\n"), budget);
      assert.ok(res);
      const objs = parse(res.lines);
      assert.ok(/^a\dx$/.test(objs[1].uuid), `resumed mid-message at ${objs[1].uuid}`);
      assertResumable(objs);
    }
  });

  it("skips a resume point whose suffix would orphan a tool_result or a parent link", () => {
    // Each step's result lands after the NEXT message has started, so resuming at
    // a{s+1} would carry r{s} without the tool_use it answers (and with a dangling parent).
    const lines = [userPrompt("p", null, "go")];
    for (let s = 0; s < 10; s++) {
      lines.push(
        asstLine(`a${s}`, s === 0 ? "p" : `a${s - 1}`, `m${s}`, {
          type: "tool_use",
          id: `t${s}`,
          name: "Bash",
          input: {},
        }),
      );
      if (s > 0) lines.push(bigResult(`r${s - 1}`, `a${s - 1}`, `t${s - 1}`, 1000));
    }
    lines.push(bigResult("r9", "a9", "t9", 1000));
    for (let budget = 600; budget <= 4000; budget += 137) {
      const res = buildSeededTranscript(lines.join("\n"), budget);
      assert.ok(res);
      assertResumable(parse(res.lines));
    }
  });

  it("keeps a whole final turn that fits, and earlier turns while they fit", () => {
    const lines = [
      userPrompt("u0", null, "earlier"),
      assistant("a0", "u0", [{ type: "text", text: "e".repeat(2000) }]), // ~1000
      ...toolLoopTurn(3, 2000).map((l) => l.replace('"parentUuid":null', '"parentUuid":"a0"')), // ~3000
    ];
    const res = buildSeededTranscript(lines.join("\n"), 5_000);
    assert.ok(res);
    const objs = parse(res.lines);
    assert.equal(objs[0].uuid, "u0");
    assert.equal(objs.length, lines.length);
    assert.ok(!JSON.stringify(objs).includes(TRIMMED_TURN_MARKER));
  });
});

/**
 * Read a seeded transcript back through the SDK's own transcript reader, which walks
 * parentUuid from the leaf as resume does — a broken re-link surfaces as a truncated
 * (or empty) conversation.
 */
async function readBackViaSdk(res: { sessionId: string; lines: string[] }) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "seed-sdk-")));
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = resolve(root, "config");
  try {
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    const cwd = resolve(root, "home");
    const projectDir = resolve(root, "config", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(cwd);
    writeFileSync(resolve(projectDir, `${res.sessionId}.jsonl`), `${res.lines.join("\n")}\n`);
    return await getSessionMessages(res.sessionId, { dir: cwd });
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
}

const markerCount = (lines: string[]) =>
  lines.join("\n").split(JSON.stringify(TRIMMED_TURN_MARKER).slice(1, -1)).length - 1;

describe("buildSeededTranscript — trimmed turn round-trips through the SDK's transcript reader", () => {
  it("getSessionMessages rebuilds the whole trimmed chain, prompt to final step", async () => {
    const res = buildSeededTranscript(toolLoopTurn(40, 2000).join("\n"), 10_000);
    assert.ok(res);
    const msgs = await readBackViaSdk(res);
    const chain = parse(res.lines).filter((o) => o.type === "user" || o.type === "assistant");
    assert.deepEqual(
      msgs.map((m) => m.uuid),
      chain.map((o) => o.uuid),
    );
    assert.equal(msgs[0].uuid, "p");
    assert.ok(JSON.stringify(msgs[0].message).includes(TRIMMED_TURN_MARKER));
    assert.equal(msgs.at(-1)?.uuid, "final");
  });

  it("re-links the resumed step to the prompt's chain, not an off-chain attachment", async () => {
    // The attachment is the last uuid'd line before the first step, but it hangs off
    // the chain (its parent isn't in the transcript); the first step hangs off the prompt.
    const lines = toolLoopTurn(40, 2000).map((l) => {
      const o = JSON.parse(l);
      if (o.uuid === "att") o.parentUuid = "elsewhere";
      if (o.uuid === "a0") o.parentUuid = "p";
      return JSON.stringify(o);
    });
    const res = buildSeededTranscript(lines.join("\n"), 10_000);
    assert.ok(res);
    const resumed = parse(res.lines).find((o, k) => k > 0 && o.type === "assistant");
    assert.equal(resumed.parentUuid, "p");
    const msgs = await readBackViaSdk(res);
    assert.equal(msgs[0].uuid, "p");
    assert.equal(msgs.at(-1)?.uuid, "final");
  });

  it("re-seeding an already-trimmed turn keeps one marker, counted once", async () => {
    const first = buildSeededTranscript(toolLoopTurn(40, 2000).join("\n"), 10_000);
    assert.ok(first);
    const objs = parse(first.lines);
    // Budget that fits everything but the first kept step — with the marker counted
    // once. Counting it twice would drop a second step too.
    const resumeIdx = objs.findIndex((o, k) => k > 0 && o.type === "assistant");
    const nextIdx = objs.findIndex((o, k) => k > resumeIdx + 1 && o.type === "assistant");
    const firstStep = estimate(objs.slice(resumeIdx, nextIdx));
    const budget = estimate(objs) - firstStep + 1;

    const again = buildSeededTranscript(first.lines.join("\n"), budget);
    assert.ok(again);
    const againObjs = parse(again.lines);
    assert.equal(markerCount(again.lines), 1);
    assert.equal(againObjs.length, objs.length - (nextIdx - resumeIdx));
    assert.ok(estimate(againObjs) <= budget);
    assertResumable(againObjs);
    const msgs = await readBackViaSdk(again);
    assert.equal(msgs[0].uuid, "p");
    assert.equal(msgs.at(-1)?.uuid, "final");
  });
});

describe("estimateLineTokens", () => {
  it("counts an image at a flat cost, not by its base64 size", () => {
    const line = {
      type: "user",
      uuid: "r",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) },
              },
            ],
          },
        ],
      },
    };
    const est = estimateLineTokens(line);
    assert.ok(est > 500 && est < 3000, `image estimated at ${est}`);
  });

  it("counts only what reaches the model — not the toolUseResult copy or line metadata", () => {
    const withCopy = JSON.parse(bigResult("r", "a", "t", 4000));
    const without = { ...withCopy, toolUseResult: undefined, cwd: "/x".repeat(500) };
    assert.equal(estimateLineTokens(withCopy), estimateLineTokens(without));
    // ~2 chars/token measured on opus-5; the estimate may over-count, never by much.
    const est = estimateLineTokens(withCopy);
    assert.ok(est >= 2000 && est <= 2400, `4000 chars estimated at ${est}`);
  });

  it("counts a thinking block by its signature (the replayed full thinking), not its summary", () => {
    const line = {
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "short summary", signature: "S".repeat(8000) }],
      },
    };
    assert.equal(estimateLineTokens(line), 2000); // 8000 signature chars / 4
  });

  it("does not count marker lines", () => {
    assert.equal(estimateLineTokens({ type: "mode", sessionId: OLD, value: "x".repeat(9999) }), 0);
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
      userPrompt("u1", null, "f".repeat(100)),
      assistant("a1", "u1", [{ type: "text", text: "h".repeat(100) }]),
      userPrompt("u2", "a1", "s".repeat(100)),
      assistant("a2", "u2", [{ type: "text", text: "b".repeat(100) }]),
    ];
    // Tight budget (each turn ~100 est tokens) so the tail starts at u2 (a real parentUuid = "a1").
    const res = buildSeededTranscript(lines.join("\n"), 150);
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

  it("returns the base restored note unchanged when the archived-at is unknown", () => {
    assert.equal(
      buildSeededNote({ cause: "restored", archivedAtMs: null }),
      SEEDED_SESSION_NOTE_BASE,
    );
    // Cause defaults to restored.
    assert.equal(buildSeededNote({}), SEEDED_SESSION_NOTE_BASE);
  });

  it("adds a coarse gap clause in minutes / hours / days", () => {
    const base = Date.UTC(2026, 6, 18, 12, 0);
    const note = (nowMs: number) =>
      buildSeededNote({ cause: "restored", archivedAtMs: base, nowMs });
    assert.match(note(base + 6 * 3_600_000), /the break lasted about 6 hours\)/);
    assert.match(note(base + 45 * 60_000), /the break lasted about 45 minutes\)/);
    assert.match(note(base + 2 * 86_400_000), /the break lasted about 2 days\)/);
    // Singular forms.
    assert.match(note(base + 60 * 60_000), /about 1 hour\)/);
    // Sub-minute gap.
    assert.match(note(base + 5_000), /the break lasted less than a minute\)/);
    // The rest of the note text is preserved.
    assert.match(note(base + 3_600_000), /a fresh session begins here\.$/);
  });

  it("falls back to the base note for a negative (clock-skew) gap", () => {
    const base = Date.UTC(2026, 6, 18, 12, 0);
    assert.equal(
      buildSeededNote({ cause: "restored", archivedAtMs: base, nowMs: base - 60_000 }),
      SEEDED_SESSION_NOTE_BASE,
    );
  });

  it("returns the rotation note (no gap clause) for the rotation cause", () => {
    const note = buildSeededNote({ cause: "rotation", archivedAtMs: Date.UTC(2026, 6, 18, 12, 0) });
    assert.equal(note, ROTATED_SESSION_NOTE);
    assert.doesNotMatch(note, /the break lasted/);
    assert.match(note, /volute mind history/);
  });

  it("rotation note is a single line and points at history", () => {
    assert.ok(!ROTATED_SESSION_NOTE.includes("\n"), "must be one line");
    assert.ok(ROTATED_SESSION_NOTE.includes("volute mind history"));
    assert.ok(ROTATED_SESSION_NOTE.length < 300, "keep it short");
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

  it("seeds a fresh persistent session: writes a synthetic transcript and returns its id + archived-at", async () => {
    const { home, sessionsDir, projectDir } = setup(OLD, transcript);
    const seeded = await seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 });
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

  it("returns null when seedTokens is 0 (disabled)", async () => {
    const { home, sessionsDir } = setup(OLD, transcript);
    assert.equal(await seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 0 }), null);
  });

  it("returns null for an ephemeral new-* session", async () => {
    const { home, sessionsDir } = setup(OLD, transcript);
    assert.equal(
      await seedSession({ cwd: home, sessionsDir, name: "new-abc", seedTokens: 30000 }),
      null,
    );
  });

  it("returns null when there is no archived pointer", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "seed-none-"));
    const home = resolve(root, "home");
    mkdirSync(home, { recursive: true });
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    assert.equal(
      await seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 }),
      null,
    );
  });

  it("returns null when the archived transcript jsonl no longer exists", async () => {
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
    assert.equal(
      await seedSession({ cwd: home, sessionsDir, name: "main", seedTokens: 30000 }),
      null,
    );
  });
});

// --- archive pointer format (must match sleep-manager's archiveSessions) ---

describe("archivePointerTimestamp / writeRotationArchivePointer", () => {
  it("formats the timestamp as UTC minute-precision, matching sleep archival", async () => {
    const d = new Date("2026-07-19T14:30:45.123Z");
    // sleep-manager: toISOString().replace(/[:.]/g,"-").slice(0,16)
    assert.equal(archivePointerTimestamp(d), "2026-07-19T14-30");
  });

  it("writes a pointer that findLatestArchivedSession reads back", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "rot-archive-"));
    const now = new Date("2026-07-19T14:30:00.000Z");
    writeRotationArchivePointer(dir, "main", "rotated-out-id", now);
    // File lands at <dir>/archive/main-2026-07-19T14-30-<id>.json holding its exact time.
    const written = JSON.parse(
      readFileSync(resolve(dir, "archive", "main-2026-07-19T14-30-rotated-out-id.json"), "utf-8"),
    );
    assert.deepEqual(written, { sessionId: "rotated-out-id", archivedAt: now.getTime() });
    const found = findLatestArchivedSession(dir, "main");
    assert.equal(found?.sessionId, "rotated-out-id");
    assert.equal(found?.archivedAt, Date.UTC(2026, 6, 19, 14, 30));
  });
});

// --- rotateSession: end-to-end in-place rotation ---

describe("rotateSession", () => {
  /** Mind-like layout: <home>/.claude/projects/proj/<oldId>.jsonl + a sessions dir. */
  function setup(oldId: string, transcript: string) {
    const root = mkdtempSync(resolve(tmpdir(), "rotate-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${oldId}.jsonl`), `${transcript}\n`);
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    return { home, sessionsDir, projectDir };
  }

  // Rotation-time transcript: three whole turns.
  const rotationTranscript = [
    userPrompt("u1", null, "first"),
    assistant("a1", "u1", [{ type: "text", text: "hi" }]),
    userPrompt("u2", "a1", "second"),
    assistant("a2", "u2", [{ type: "text", text: "done" }]),
    userPrompt("u3", "a2", "third"),
    assistant("a3", "u3", [{ type: "text", text: "saved" }]),
  ].join("\n");

  it("writes the budget tail synthetic session and archives the rotated-out pointer", async () => {
    const { home, sessionsDir, projectDir } = setup(OLD, rotationTranscript);
    const newId = (
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "main",
        oldSessionId: OLD,
        seedTokens: 1_000_000, // large → whole transcript
      })
    )?.sessionId;
    assert.ok(newId);
    assert.notEqual(newId, OLD);
    // Synthetic file written next to the source, the budget-based trailing tail.
    const objs = parse(
      readFileSync(resolve(projectDir, `${newId}.jsonl`), "utf-8")
        .trim()
        .split("\n"),
    );
    assert.equal(objs[0].uuid, "u1"); // budget kept everything
    assert.equal(objs[0].parentUuid, null); // detached from dropped history
    // Rotated-out session archived so the full transcript stays findable.
    const found = findLatestArchivedSession(sessionsDir, "main");
    assert.equal(found?.sessionId, OLD);
  });

  it("keeps only the trailing turns that fit a tight budget", async () => {
    const { home, sessionsDir, projectDir } = setup(OLD, rotationTranscript);
    const newId = (
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "main",
        oldSessionId: OLD,
        seedTokens: 3, // tight → only the final turn ("third" + "saved" ≈ 5 est tokens) survives
      })
    )?.sessionId;
    assert.ok(newId);
    const objs = parse(
      readFileSync(resolve(projectDir, `${newId}.jsonl`), "utf-8")
        .trim()
        .split("\n"),
    );
    assert.equal(objs.length, 2); // u3, a3
    assert.equal(objs[0].uuid, "u3");
    assert.equal(objs[0].parentUuid, null);
  });

  it("rotates an ephemeral new-* session without writing an archive pointer", async () => {
    const { home, sessionsDir, projectDir } = setup(OLD, rotationTranscript);
    const newId = (
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "new-abc",
        oldSessionId: OLD,
        seedTokens: 30000,
      })
    )?.sessionId;
    assert.ok(newId);
    // Synthetic file exists (needed to resume) ...
    assert.ok(readFileSync(resolve(projectDir, `${newId}.jsonl`), "utf-8"));
    // ... but no archive pointer for an ephemeral session.
    assert.equal(findLatestArchivedSession(sessionsDir, "new-abc"), null);
  });

  it("returns null when the live transcript can't be found", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "rotate-none-"));
    const home = resolve(root, "home");
    mkdirSync(home, { recursive: true });
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    assert.equal(
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "main",
        oldSessionId: "missing",
        seedTokens: 30000,
      }),
      null,
    );
  });
});

// --- Recollection seeded ahead of the tail (#1124) ---

const RECALL: RecallEntry[] = [
  {
    period: "week",
    period_key: "2026-W38",
    start: "2026-09-14T00:00:00.000Z",
    end: "2026-09-21T00:00:00.000Z",
    content: "The week I learned to garden.",
    author: "consolidation",
  },
  {
    period: "day",
    period_key: "2026-09-22",
    start: "2026-09-22T00:00:00.000Z",
    end: "2026-09-23T00:00:00.000Z",
    content: "I rewrote the pond poem twice.",
    author: "mind",
  },
  {
    period: "hour",
    period_key: "2026-09-23T09",
    start: "2026-09-23T09:00:00.000Z",
    end: "2026-09-23T10:00:00.000Z",
    content: "Talked with alice about moss.",
    author: "consolidation",
  },
];

const twoTurns = [
  userPrompt("u1", null, "hello", "2026-09-23T10:00:00.000Z"),
  assistant("a1", "u1", [{ type: "text", text: "hi there" }]),
  userPrompt("u2", "a1", "again", "2026-09-23T10:05:00.000Z"),
  assistant("a2", "u2", [{ type: "text", text: "yes" }]),
].join("\n");

describe("recallLabel", () => {
  it("names each period where it sits in time", () => {
    assert.equal(recallLabel(RECALL[0], "UTC"), "the week of Mon 14 Sep");
    assert.equal(recallLabel(RECALL[1], "UTC"), "Tuesday 22 Sep");
    assert.equal(recallLabel(RECALL[2], "UTC"), "Wednesday 23 Sep, 09:00–10:00");
  });

  it("puts hours in the given (local) time zone", () => {
    assert.equal(recallLabel(RECALL[2], "America/Los_Angeles"), "Wednesday 23 Sep, 02:00–03:00");
  });

  it("names days and weeks by their period key, not a local conversion of start", () => {
    // West of UTC, the UTC-midnight start of 22 Sep is still the evening of the 21st —
    // but the daemon filed this memory under the 22nd, and that's the day it is.
    assert.equal(recallLabel(RECALL[1], "America/Los_Angeles"), "Tuesday 22 Sep");
    assert.equal(recallLabel(RECALL[0], "America/Los_Angeles"), "the week of Mon 14 Sep");
    // ISO week 1 of 2026 starts in 2025.
    assert.equal(
      recallLabel({ ...RECALL[0], period_key: "2026-W01" }, "UTC"),
      "the week of Mon 29 Dec",
    );
  });
});

describe("buildSeededTranscript — recall entries", () => {
  it("places recall pairs oldest-first ahead of the tail, chained into it", () => {
    const res = buildSeededTranscript(twoTurns, 1_000_000, RECALL, "UTC");
    assert.ok(res);
    assert.equal(res.recallEntries, 3);
    const objs = parse(res.lines);
    const recall = objs.slice(0, 6);
    assert.ok(recall.every((o) => o.voluteRecall === true && o.sessionId === res.sessionId));
    assert.deepEqual(
      recall.map((o) => o.type),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
    );
    // Honest provenance on the first entry, then time-placed labels.
    assert.equal(recall[0].message.content, `${RECALL_PREAMBLE}\n[recall: the week of Mon 14 Sep]`);
    assert.equal(recall[2].message.content, "[recall: Tuesday 22 Sep — you wrote this one]");
    assert.equal(recall[4].message.content, "[recall: Wednesday 23 Sep, 09:00–10:00]");
    // The memory is the mind's own plain assistant text.
    assert.deepEqual(recall[1].message.content, [{ type: "text", text: RECALL[0].content }]);
    // Chain: null root, each line on the previous, tail's first event on the last memory.
    assert.equal(recall[0].parentUuid, null);
    for (let k = 1; k < objs.length; k++) assert.equal(objs[k].parentUuid, objs[k - 1].uuid);
    assert.equal(objs[6].uuid, "u1");
    assertResumable(objs);
  });

  it("labels an unconsolidated hour as a plain record, not a memory", () => {
    const record = { ...RECALL[2], author: "record" };
    const res = buildSeededTranscript(twoTurns, 1_000_000, [record], "UTC");
    assert.ok(res);
    assert.equal(
      parse(res.lines)[0].message.content,
      `${RECALL_PREAMBLE}\n[recall: Wednesday 23 Sep, 09:00–10:00 — a plain record of turn summaries, not yet a memory]`,
    );
  });

  it("does not charge recollection against the tail budget", () => {
    const budget = estimate(parse(twoTurns.split("\n")));
    const without = buildSeededTranscript(twoTurns, budget);
    const withRecall = buildSeededTranscript(twoTurns, budget, RECALL, "UTC");
    assert.ok(without && withRecall);
    assert.equal(withRecall.lines.length, without.lines.length + 6);
  });

  it("round-trips through the SDK's transcript reader: memories, then the tail", async () => {
    const res = buildSeededTranscript(twoTurns, 1_000_000, RECALL, "UTC");
    assert.ok(res);
    const msgs = await readBackViaSdk(res);
    assert.deepEqual(
      msgs.map((m) => m.uuid),
      parse(res.lines).map((o) => o.uuid),
    );
    assert.equal(msgs.at(-1)?.uuid, "a2");
  });

  it("carries a full recollection (a week, six days, today's hours) as one valid chain", async () => {
    const days = Array.from({ length: 6 }, (_, k): RecallEntry => {
      const d = `2026-09-${String(15 + k).padStart(2, "0")}`;
      const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString();
      return {
        period: "day",
        period_key: d,
        start: `${d}T00:00:00.000Z`,
        end: next,
        content: `day ${k}`,
        author: "consolidation",
      };
    });
    const all = [RECALL[0], ...days, RECALL[2], { ...RECALL[2], author: "record" }];
    const res = buildSeededTranscript(twoTurns, 1_000_000, all, "UTC");
    assert.ok(res);
    assert.equal(res.recallEntries, all.length);
    const objs = parse(res.lines);
    assertResumable(objs);
    const msgs = await readBackViaSdk(res);
    assert.equal(msgs.length, all.length * 2 + 4);
    assert.equal(msgs.at(-1)?.uuid, "a2");
  });

  it("round-trips on top of a trimmed turn", async () => {
    const res = buildSeededTranscript(toolLoopTurn(40, 2000).join("\n"), 10_000, RECALL, "UTC");
    assert.ok(res);
    const objs = parse(res.lines);
    assertResumable(objs);
    const msgs = await readBackViaSdk(res);
    const chain = objs.filter((o) => o.type === "user" || o.type === "assistant");
    assert.deepEqual(
      msgs.map((m) => m.uuid),
      chain.map((o) => o.uuid),
    );
    assert.equal(msgs[6].uuid, "p");
    assert.ok(JSON.stringify(msgs[6].message).includes(TRIMMED_TURN_MARKER));
    assert.equal(msgs.at(-1)?.uuid, "final");
  });

  it("re-seeding a seeded transcript replaces its recall entries rather than keeping them", async () => {
    const first = buildSeededTranscript(twoTurns, 1_000_000, RECALL, "UTC");
    assert.ok(first);
    const again = buildSeededTranscript(first.lines.join("\n"), 1_000_000, [RECALL[2]], "UTC");
    assert.ok(again);
    const objs = parse(again.lines);
    assert.equal(objs.filter((o) => o.voluteRecall).length, 2);
    assert.equal(again.lines.join("\n").split("What follows is what you remember").length, 2);
    assert.equal(objs[2].uuid, "u1");
    assertResumable(objs);
    const msgs = await readBackViaSdk(again);
    assert.equal(msgs.length, objs.length);
  });
});

describe("seedSession / rotateSession — recollection", () => {
  function setup(transcript: string) {
    const root = mkdtempSync(resolve(tmpdir(), "seed-recall-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${OLD}.jsonl`), `${transcript}\n`);
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(resolve(sessionsDir, "archive"), { recursive: true });
    return { home, sessionsDir, projectDir };
  }

  function read(projectDir: string, id: string) {
    return parse(
      readFileSync(resolve(projectDir, `${id}.jsonl`), "utf-8")
        .trim()
        .split("\n"),
    );
  }

  it("asks for memories before the archive time, up to where the tail starts", async () => {
    const { home, sessionsDir, projectDir } = setup(twoTurns);
    writeRotationArchivePointer(sessionsDir, "main", OLD, new Date("2026-09-23T11:30:00Z"));
    const queries: RecollectionQuery[] = [];
    const seeded = await seedSession({
      cwd: home,
      sessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      recollect: async (q) => {
        queries.push(q);
        return RECALL;
      },
      timeZone: "UTC",
    });
    assert.ok(seeded);
    assert.deepEqual(queries, [
      { before: "2026-09-23T11:30:00.000Z", tailStartedAt: "2026-09-23T10:00:00.000Z" },
    ]);
    const objs = read(projectDir, seeded.sessionId);
    assert.equal(objs.filter((o) => o.voluteRecall).length, 6);
    assert.equal(objs[6].uuid, "u1");
  });

  for (const [what, recollect] of [
    [
      "rejects",
      async () => {
        throw new Error("daemon down");
      },
    ],
    ["returns malformed entries", async () => [{ nope: true }, "x"]],
    ["returns a non-array", async () => ({ entries: [] }) as unknown as unknown[]],
  ] as const) {
    it(`fails soft to a tail-only seed when recollection ${what}`, async () => {
      const { home, sessionsDir, projectDir } = setup(twoTurns);
      writeRotationArchivePointer(sessionsDir, "main", OLD, new Date("2026-09-23T11:30:00Z"));
      const seeded = await seedSession({
        cwd: home,
        sessionsDir,
        name: "main",
        seedTokens: 1_000_000,
        recollect,
      });
      assert.ok(seeded);
      const objs = read(projectDir, seeded.sessionId);
      assert.equal(objs.filter((o) => o.voluteRecall).length, 0);
      assert.equal(objs[0].uuid, "u1");
      assert.equal(objs[0].parentUuid, null);
    });
  }

  it("rotation seeds recollection ahead of its tail too", async () => {
    const { home, sessionsDir, projectDir } = setup(twoTurns);
    const newId = (
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "main",
        oldSessionId: OLD,
        seedTokens: 1_000_000,
        recollect: async () => RECALL,
      })
    )?.sessionId;
    assert.ok(newId);
    const objs = read(projectDir, newId);
    assert.equal(objs.filter((o) => o.voluteRecall).length, 6);
    assertResumable(objs);
  });

  it("names the quiet since the last activity in the cold seam note", () => {
    const lastActivity = Date.UTC(2026, 8, 23, 10, 5);
    const note = buildSeededNote({
      cause: "cold",
      archivedAtMs: lastActivity,
      nowMs: lastActivity + 2 * 3_600_000,
    });
    assert.ok(note.includes("(the quiet lasted about 2 hours)"), note);
    assert.equal(buildSeededNote({ cause: "cold", archivedAtMs: null }), COLD_SESSION_NOTE_BASE);
  });

  it("words the rotation note for recollection only where recollection is seeded", () => {
    assert.equal(buildSeededNote({ cause: "rotation" }), ROTATED_SESSION_NOTE);
    assert.equal(
      buildSeededNote({ cause: "rotation", recollection: true }),
      ROTATED_SESSION_NOTE + RECALL_NOTE_SUFFIX,
    );
    // Cold and restored notes, too: recall wording only when recall was seeded.
    for (const cause of ["cold", "restored"] as const) {
      assert.ok(!buildSeededNote({ cause }).includes("[recall"));
      assert.ok(buildSeededNote({ cause, recollection: true }).endsWith(RECALL_NOTE_SUFFIX));
    }
  });
});

describe("archive pointers — collisions and ordering", () => {
  function archiveDir() {
    const sessionsDir = mkdtempSync(resolve(tmpdir(), "archive-order-"));
    mkdirSync(resolve(sessionsDir, "archive"));
    return sessionsDir;
  }

  it("a rotation and a cold reset in the same minute keep both pointers, newest wins", () => {
    const sessionsDir = archiveDir();
    writeRotationArchivePointer(
      sessionsDir,
      "main",
      "rotated-out",
      new Date("2026-09-23T10:00:10Z"),
    );
    writeRotationArchivePointer(
      sessionsDir,
      "main",
      "cold-reset",
      new Date("2026-09-23T10:00:50Z"),
    );
    assert.equal(readdirSync(resolve(sessionsDir, "archive")).length, 2);
    const found = findLatestArchivedSession(sessionsDir, "main");
    assert.equal(found?.sessionId, "cold-reset");
    assert.equal(found?.archivedAt, Date.parse("2026-09-23T10:00:50Z"));
  });

  it("orders by archival time, not by filename", () => {
    const sessionsDir = archiveDir();
    // Written out of order within one minute: the filename minute ties, archivedAt decides.
    writeRotationArchivePointer(sessionsDir, "main", "zzz-later", new Date("2026-09-23T10:00:40Z"));
    writeRotationArchivePointer(
      sessionsDir,
      "main",
      "aaa-earlier",
      new Date("2026-09-23T10:00:05Z"),
    );
    assert.equal(findLatestArchivedSession(sessionsDir, "main")?.sessionId, "zzz-later");
  });

  it("a sleep archive outranks a template pointer from earlier in the same minute", () => {
    const sessionsDir = archiveDir();
    writeRotationArchivePointer(
      sessionsDir,
      "main",
      "cold-reset",
      new Date("2026-09-23T10:00:30Z"),
    );
    // The daemon's sleep archival: minute-only name, bare { sessionId }.
    writeFileSync(
      resolve(sessionsDir, "archive", "main-2026-09-23T10-00.json"),
      JSON.stringify({ sessionId: "slept" }),
    );
    const found = findLatestArchivedSession(sessionsDir, "main");
    assert.equal(found?.sessionId, "slept");
    assert.equal(found?.archivedAt, Date.UTC(2026, 8, 23, 10, 0));
  });
});

describe("rotateSession — a failed seed leaves the session resumable", () => {
  it("writes no archive pointer and no new transcript when the source can't be seeded", async () => {
    // A cold reset rotates the live session and retires its pointer only on success;
    // an archive pointer written for a failed seed would send the next wake to it.
    const root = mkdtempSync(resolve(tmpdir(), "rotate-fail-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      resolve(projectDir, `${OLD}.jsonl`),
      `${userPrompt("u1", null, "hi")}\n{corrupt\n`,
    );
    const sessionsDir = resolve(root, ".mind", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    let asked = false;
    const newId = (
      await rotateSession({
        cwd: home,
        sessionsDir,
        name: "main",
        oldSessionId: OLD,
        seedTokens: 10_000,
        recollect: async () => {
          asked = true;
          return RECALL;
        },
      })
    )?.sessionId;
    assert.equal(newId, undefined);
    assert.equal(asked, false, "no recollection fetch for a seed that can't be built");
    assert.equal(findLatestArchivedSession(sessionsDir, "main"), null);
    assert.deepEqual(readdirSync(projectDir), [`${OLD}.jsonl`]);
  });
});

describe("seed budgets follow what arrived (#1124)", () => {
  /** Eight turns of ~4.5k estimated tokens each: a 10k tail keeps 2, a 30k tail keeps 6. */
  const bigTurns = Array.from({ length: 8 }, (_, t) => [
    userPrompt(
      `u${t}`,
      t === 0 ? null : `a${t - 1}`,
      "x".repeat(8000),
      `2026-09-23T0${t}:00:00.000Z`,
    ),
    assistant(`a${t}`, `u${t}`, [{ type: "text", text: "ok" }]),
  ]).flat();

  function setup() {
    const root = mkdtempSync(resolve(tmpdir(), "seed-budget-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${OLD}.jsonl`), `${bigTurns.join("\n")}\n`);
    const sessionsDir = resolve(root, ".mind", "sessions");
    writeRotationArchivePointer(sessionsDir, "main", OLD, new Date("2026-09-23T09:00:00Z"));
    return { home, sessionsDir, projectDir };
  }

  async function seedWith(recollect: () => Promise<unknown[]>) {
    const { home, sessionsDir, projectDir } = setup();
    const seeded = await seedSession({ cwd: home, sessionsDir, name: "main", recollect });
    assert.ok(seeded);
    const objs = parse(
      readFileSync(resolve(projectDir, `${seeded.sessionId}.jsonl`), "utf-8")
        .trim()
        .split("\n"),
    );
    return objs.filter((o) => !o.voluteRecall && o.type === "user").length;
  }

  it("keeps the short tail when recollection arrived", async () => {
    assert.equal(await seedWith(async () => [RECALL[0]]), 2);
  });

  it("keeps the long tail when recollection failed or came back empty", async () => {
    assert.equal(
      await seedWith(async () => {
        throw new Error("daemon down");
      }),
      6,
    );
    assert.equal(await seedWith(async () => []), 6);
    assert.ok(DEFAULT_SEED_TOKENS < TAIL_ONLY_SEED_TOKENS);
  });
});

describe("recollection validation and cap", () => {
  it("drops a malformed entry on its own, keeping the rest", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "seed-valid-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${OLD}.jsonl`), `${twoTurns}\n`);
    const sessionsDir = resolve(root, ".mind", "sessions");
    writeRotationArchivePointer(sessionsDir, "main", OLD, new Date("2026-09-23T11:00:00Z"));
    const seeded = await seedSession({
      cwd: home,
      sessionsDir,
      name: "main",
      seedTokens: 1_000_000,
      timeZone: "UTC",
      recollect: async () => [
        RECALL[0],
        { ...RECALL[1], period_key: null },
        { ...RECALL[1], end: "not a date" },
        RECALL[2],
      ],
    });
    assert.ok(seeded);
    assert.equal(seeded.recallEntries, 2);
  });

  it("holds recollection to its cap: oldest days go first, the week stays if it fits", () => {
    const day = (k: number): RecallEntry => ({
      ...RECALL[1],
      period_key: `2026-09-${15 + k}`,
      content: "d".repeat(3600), // ~2k estimated tokens each
    });
    const week = { ...RECALL[0], content: "w".repeat(900) };
    const entries = [week, ...Array.from({ length: 6 }, (_, k) => day(k))];
    const capped = capRecollection(entries, 7000);
    // Three newest days (~6.1k) plus the short week line fit; the three oldest days don't.
    assert.deepEqual(
      capped.map((e) => e.period_key),
      ["2026-W38", "2026-09-18", "2026-09-19", "2026-09-20"],
    );
    // A week line too big for what's left is dropped, not the newer days.
    const bigWeek = { ...week, content: "w".repeat(9000) };
    assert.ok(!capRecollection([bigWeek, day(5)], 5000).includes(bigWeek));
  });
});

describe("rotateSession — a cold reset only when it helps", () => {
  it("keeps a session no larger than its seed would be", async () => {
    // ~15k estimated tokens of transcript, against a 35k floor.
    const lines = [
      userPrompt("u1", null, "y".repeat(27000)),
      assistant("a1", "u1", [{ type: "text", text: "fine" }]),
    ];
    const root = mkdtempSync(resolve(tmpdir(), "cold-small-"));
    const home = resolve(root, "home");
    const projectDir = resolve(home, ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${OLD}.jsonl`), `${lines.join("\n")}\n`);
    const sessionsDir = resolve(root, ".mind", "sessions");
    let asked = false;
    const opts = {
      cwd: home,
      sessionsDir,
      name: "main",
      oldSessionId: OLD,
      recollect: async () => {
        asked = true;
        return [];
      },
    };
    assert.equal(await rotateSession({ ...opts, minSourceTokens: 35_000 }), null);
    assert.equal(asked, false);
    assert.equal(findLatestArchivedSession(sessionsDir, "main"), null);
    // Above the floor, the same transcript is re-seeded.
    assert.ok(await rotateSession({ ...opts, minSourceTokens: 10_000 }));
  });
});

describe("findLatestArchivedSession — newest minute first", () => {
  it("falls back a minute only when none of the newest minute's pointers is readable", () => {
    const sessionsDir = mkdtempSync(resolve(tmpdir(), "archive-minute-"));
    mkdirSync(resolve(sessionsDir, "archive"));
    writeRotationArchivePointer(sessionsDir, "main", "older", new Date("2026-09-23T09:59:30Z"));
    writeFileSync(resolve(sessionsDir, "archive", "main-2026-09-23T10-00.json"), "{corrupt");
    assert.equal(findLatestArchivedSession(sessionsDir, "main")?.sessionId, "older");
  });
});
