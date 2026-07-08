import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  getCachedContextInfo,
  type ParsedContext,
  processClaudeSession,
} from "../templates/_base/src/lib/context-breakdown.js";

const tmpDir = join(tmpdir(), `.volute-context-breakdown-test-${process.pid}`);

// Token estimation fallback used when @anthropic-ai/tokenizer is unavailable
// (which it is in the test environment). Lets us assert exact breakdown counts.
const est = (s: string) => Math.round(s.length / 3.5);

before(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("context-breakdown streaming parser", () => {
  const THINK = "thinking about the problem carefully";
  const ATEXT = "here is my considered answer";
  const TRESULT = "the tool produced this output";
  const UTEXT = "what is the answer to my question";
  const TOOL_INPUT = { command: "ls -la /tmp" };

  it("golden: streaming parser yields the expected ContextInfo + messages", async () => {
    const filePath = join(tmpDir, "session-golden.jsonl");
    // Include edge cases the old readFileSync+split path tolerated: a blank line,
    // a malformed JSON line (skipped), and a trailing newline.
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          usage: { input_tokens: 100, cache_read_input_tokens: 50 },
          content: [
            { type: "thinking", thinking: THINK },
            { type: "text", text: ATEXT },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: TRESULT }],
        },
      }),
      "",
      "{ this is not valid json",
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 200,
            cache_creation_input_tokens: 80,
            cache_read_input_tokens: 120,
          },
          content: [{ type: "tool_use", name: "Bash", input: TOOL_INPUT }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: UTEXT }] },
      }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await processClaudeSession(filePath, 11, 22, 33);

    const expectedParsed: ParsedContext = {
      // Last assistant usage wins: 200 + 80 + 120
      contextTokens: 400,
      breakdown: {
        systemPrompt: 11,
        sdkInstructions: 22,
        skillDescriptions: 33,
        conversation: {
          userText: est(UTEXT),
          assistantText: est(ATEXT),
          thinking: est(THINK),
          toolUse: est(JSON.stringify(TOOL_INPUT)),
          toolResult: est(TRESULT),
        },
      },
    };
    assert.deepEqual(result.parsed, expectedParsed);

    assert.deepEqual(result.messages, [
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: THINK },
          { type: "text", text: ATEXT },
        ],
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", text: TRESULT, isError: false }],
      },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", name: "Bash", input: JSON.stringify(TOOL_INPUT, null, 2) }],
      },
      { role: "user", blocks: [{ type: "text", text: UTEXT }] },
    ]);
  });

  it("returns empty result for a missing file", async () => {
    const result = await processClaudeSession(join(tmpDir, "does-not-exist.jsonl"), 0, 0, 0);
    assert.deepEqual(result, { parsed: null, messages: [] });
  });
});

describe("getCachedContextInfo", () => {
  it("caches by file identity: unchanged file is not re-read; a change re-parses", async () => {
    const filePath = join(tmpDir, "cache-target.jsonl");
    writeFileSync(filePath, "one\n");

    let computeCount = 0;
    const sentinel: ParsedContext = {
      contextTokens: 7,
      breakdown: {
        systemPrompt: 0,
        sdkInstructions: 0,
        skillDescriptions: 0,
        conversation: { userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0 },
      },
    };
    const compute = async () => {
      computeCount++;
      return sentinel;
    };

    const first = await getCachedContextInfo(filePath, compute);
    assert.equal(computeCount, 1);
    assert.equal(first, sentinel);

    // Same file identity (mtime + size unchanged) — served from cache, no re-read.
    const second = await getCachedContextInfo(filePath, compute);
    assert.equal(computeCount, 1);
    assert.equal(second, sentinel);

    // Change the file (different size) — cache invalidates and re-parses.
    writeFileSync(filePath, "one two three\n");
    const third = await getCachedContextInfo(filePath, compute);
    assert.equal(computeCount, 2);
    assert.equal(third, sentinel);
  });

  it("returns null without computing for a missing file", async () => {
    let called = false;
    const result = await getCachedContextInfo(join(tmpDir, "nope.jsonl"), async () => {
      called = true;
      return null;
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });
});
