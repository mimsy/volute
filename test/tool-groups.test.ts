import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryMessage } from "@volute/api";
import { groupToolEvents, type TimelineItem } from "../packages/web/src/ui/lib/tool-groups";
import {
  getToolCategory,
  getToolLabel,
  normalizeToolName,
} from "../packages/web/src/ui/lib/tool-names";

function makeEvent(overrides: Partial<HistoryMessage> & { type: string }): HistoryMessage {
  return {
    id: Math.floor(Math.random() * 100000),
    mind: "test",
    channel: "",
    session: null,
    sender: null,
    message_id: null,
    content: "",
    metadata: null,
    turn_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("normalizeToolName", () => {
  it("maps lowercase pi tool names", () => {
    assert.equal(normalizeToolName("bash"), "Bash");
    assert.equal(normalizeToolName("read"), "Read");
    assert.equal(normalizeToolName("edit"), "Edit");
    assert.equal(normalizeToolName("write"), "Write");
    assert.equal(normalizeToolName("grep"), "Grep");
    assert.equal(normalizeToolName("glob"), "Glob");
  });

  it("maps codex tool names", () => {
    assert.equal(normalizeToolName("command"), "Bash");
    assert.equal(normalizeToolName("file_change"), "Edit");
    assert.equal(normalizeToolName("web_search"), "WebSearch");
  });

  it("passes through unknown names", () => {
    assert.equal(normalizeToolName("Bash"), "Bash");
    assert.equal(normalizeToolName("CustomTool"), "CustomTool");
  });
});

describe("getToolCategory", () => {
  it("categorizes shell tools", () => {
    assert.equal(getToolCategory("Bash"), "shell");
    assert.equal(getToolCategory("bash"), "shell");
    assert.equal(getToolCategory("command"), "shell");
  });

  it("categorizes file tools", () => {
    assert.equal(getToolCategory("Read"), "file");
    assert.equal(getToolCategory("Write"), "file");
    assert.equal(getToolCategory("Edit"), "file");
    assert.equal(getToolCategory("read"), "file");
  });

  it("categorizes search tools", () => {
    assert.equal(getToolCategory("Grep"), "search");
    assert.equal(getToolCategory("Glob"), "search");
  });

  it("categorizes web tools", () => {
    assert.equal(getToolCategory("WebSearch"), "web");
    assert.equal(getToolCategory("WebFetch"), "web");
  });

  it("defaults to generic", () => {
    assert.equal(getToolCategory("Task"), "generic");
    assert.equal(getToolCategory("UnknownTool"), "generic");
  });
});

describe("getToolLabel", () => {
  it("extracts bash command", () => {
    assert.equal(getToolLabel("Bash", JSON.stringify({ command: "ls -la\necho hi" })), "$ ls -la");
  });

  it("extracts file path for Read", () => {
    assert.equal(
      getToolLabel("Read", JSON.stringify({ file_path: "/foo/bar.ts" })),
      "Read /foo/bar.ts",
    );
  });

  it("extracts grep pattern", () => {
    assert.equal(
      getToolLabel("Grep", JSON.stringify({ pattern: "hello", path: "src/" })),
      'Grep "hello" in src/',
    );
  });

  it("handles invalid JSON", () => {
    assert.equal(getToolLabel("Bash", "not json"), "Bash");
  });

  it("normalizes pi tool names", () => {
    assert.equal(getToolLabel("bash", JSON.stringify({ command: "pwd" })), "$ pwd");
  });
});

describe("groupToolEvents", () => {
  it("groups tool_use + tool_result pairs", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({ id: 2, type: "tool_result", content: "output" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "tool-group");
    const group = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(group.toolUse.id, 1);
    assert.equal(group.toolResult?.id, 2);
    assert.equal(group.toolName, "Bash");
    assert.equal(group.category, "shell");
  });

  it("handles tool_use without result", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Read"}' }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "tool-group");
    const group = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(group.toolResult, null);
  });

  it("preserves non-tool events", () => {
    const events = [
      makeEvent({ id: 1, type: "text", content: "hello" }),
      makeEvent({ id: 2, type: "thinking", content: "hmm" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "event");
    assert.equal(items[1].kind, "event");
  });

  it("handles interleaved non-tool events between use and result", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({ id: 2, type: "outbound", content: "message sent" }),
      makeEvent({ id: 3, type: "tool_result", content: "done" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "tool-group");
    assert.equal(items[1].kind, "event");
    const ev = items[1] as Extract<TimelineItem, { kind: "event" }>;
    assert.equal(ev.event.id, 2);
  });

  it("handles multiple consecutive tool pairs", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Read"}' }),
      makeEvent({ id: 2, type: "tool_result", content: "file content" }),
      makeEvent({ id: 3, type: "tool_use", content: "{}", metadata: '{"name":"Edit"}' }),
      makeEvent({ id: 4, type: "tool_result", content: "edited" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "tool-group");
    assert.equal(items[1].kind, "tool-group");
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolName, "Read");
    assert.equal(g2.toolName, "Edit");
  });

  it("handles tool_use followed by another tool_use (no result)", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Read"}' }),
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Edit"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "edited" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult, null);
    assert.equal(g2.toolResult?.id, 3);
  });

  it("mixed events with tool groups", () => {
    const events = [
      makeEvent({ id: 1, type: "text", content: "thinking..." }),
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "output" }),
      makeEvent({ id: 4, type: "text", content: "done" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 3);
    assert.equal(items[0].kind, "event");
    assert.equal(items[1].kind, "tool-group");
    assert.equal(items[2].kind, "event");
  });

  it("pairs parallel tool calls by id (use A, use B, result B, result A)", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"a"}' }),
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"b"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "out B", metadata: '{"tool_use_id":"b"}' }),
      makeEvent({ id: 4, type: "tool_result", content: "out A", metadata: '{"tool_use_id":"a"}' }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    // Groups render at the tool_use position, results matched by id.
    assert.equal(g1.toolUse.id, 1);
    assert.equal(g1.toolName, "Bash");
    assert.equal(g1.toolResult?.id, 4);
    assert.equal(g2.toolUse.id, 2);
    assert.equal(g2.toolName, "Read");
    assert.equal(g2.toolResult?.id, 3);
  });

  it("matches by id even when the result precedes an intervening tool_use", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"a"}' }),
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"b"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "out A", metadata: '{"tool_use_id":"a"}' }),
      makeEvent({ id: 4, type: "tool_result", content: "out B", metadata: '{"tool_use_id":"b"}' }),
    ];
    const items = groupToolEvents(events);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 3);
    assert.equal(g2.toolResult?.id, 4);
  });

  it("mixes legacy (no id) and modern (id) tool_use events", () => {
    const events = [
      // Legacy: no id, paired positionally with the next unclaimed result.
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({ id: 2, type: "tool_result", content: "legacy out" }),
      // Modern: paired by id across a reordered result stream.
      makeEvent({ id: 3, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"m"}' }),
      makeEvent({
        id: 4,
        type: "tool_result",
        content: "modern out",
        metadata: '{"tool_use_id":"m"}',
      }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 2);
    assert.equal(g2.toolResult?.id, 4);
  });

  it("modern tool_use with no matching result gets null (no positional grab)", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"a"}' }),
      // Result belongs to a different (later) call by id.
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"b"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "out B", metadata: '{"tool_use_id":"b"}' }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult, null);
    assert.equal(g2.toolResult?.id, 3);
  });

  it("keeps only the first result when multiple share one tool_use_id", () => {
    // Production shape: two Bash tool_use rows followed by extra same-id results.
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"a"}' }),
      makeEvent({ id: 2, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"b"}' }),
      makeEvent({ id: 3, type: "tool_result", content: "out A1", metadata: '{"tool_use_id":"a"}' }),
      makeEvent({ id: 4, type: "tool_result", content: "out A2", metadata: '{"tool_use_id":"a"}' }),
      makeEvent({ id: 5, type: "tool_result", content: "out B", metadata: '{"tool_use_id":"b"}' }),
    ];
    const items = groupToolEvents(events);
    // Two groups + the extra 'a' result standalone (nothing disappears).
    assert.equal(items.length, 3);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 3);
    assert.equal(g2.toolResult?.id, 5);
    const extra = items[2] as Extract<TimelineItem, { kind: "event" }>;
    assert.equal(extra.kind, "event");
    assert.equal(extra.event.id, 4);
  });

  it("legacy scan does not steal a result already claimed by a modern id-match", () => {
    const events = [
      // Modern pair first: result matched by id.
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"m"}' }),
      makeEvent({
        id: 2,
        type: "tool_result",
        content: "modern out",
        metadata: '{"tool_use_id":"m"}',
      }),
      // Legacy id-less tool_use: its positional scan must skip the claimed result above
      // (it comes before) and find its own next unclaimed result.
      makeEvent({ id: 3, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({ id: 4, type: "tool_result", content: "legacy out" }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 2);
    assert.equal(g2.toolResult?.id, 4);
  });

  it("modern tool_use does not re-claim a result already taken by a legacy group", () => {
    const events = [
      // Legacy id-less tool_use claims the next result positionally.
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash"}' }),
      makeEvent({
        id: 2,
        type: "tool_result",
        content: "shared out",
        metadata: '{"tool_use_id":"m"}',
      }),
      // Modern tool_use whose id points at the already-claimed result must not steal it.
      makeEvent({ id: 3, type: "tool_use", content: "{}", metadata: '{"name":"Read","id":"m"}' }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    const g2 = items[1] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 2);
    // The result is already claimed, so the modern group renders without a duplicate.
    assert.equal(g2.toolResult, null);
  });

  it("emits an orphaned result standalone", () => {
    const events = [
      makeEvent({ id: 1, type: "tool_use", content: "{}", metadata: '{"name":"Bash","id":"a"}' }),
      makeEvent({ id: 2, type: "tool_result", content: "out A", metadata: '{"tool_use_id":"a"}' }),
      // Result with no matching tool_use (e.g. tool_use_id "unknown").
      makeEvent({
        id: 3,
        type: "tool_result",
        content: "orphan",
        metadata: '{"tool_use_id":"unknown"}',
      }),
    ];
    const items = groupToolEvents(events);
    assert.equal(items.length, 2);
    const g1 = items[0] as Extract<TimelineItem, { kind: "tool-group" }>;
    assert.equal(g1.toolResult?.id, 2);
    const orphan = items[1] as Extract<TimelineItem, { kind: "event" }>;
    assert.equal(orphan.kind, "event");
    assert.equal(orphan.event.id, 3);
  });
});
