import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getDb } from "../src/lib/db.js";
import {
  getMindPromptDefaults,
  getPrompt,
  getPromptIfCustom,
  PROMPT_DEFAULTS,
  PROMPT_KEYS,
} from "../src/lib/prompts.js";
import { systemPrompts } from "../src/lib/schema.js";

async function cleanup() {
  const db = await getDb();
  await db.delete(systemPrompts);
}

describe("prompts library", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("PROMPT_KEYS includes all expected keys", () => {
    assert.ok(PROMPT_KEYS.includes("seed_soul"));
    assert.ok(PROMPT_KEYS.includes("compaction_warning"));
    assert.ok(PROMPT_KEYS.includes("compaction_instructions"));
    assert.ok(PROMPT_KEYS.includes("reply_instructions"));
    assert.ok(PROMPT_KEYS.includes("channel_invite"));
    assert.ok(PROMPT_KEYS.includes("restart_message"));
    assert.ok(PROMPT_KEYS.includes("merge_message"));
    assert.ok(PROMPT_KEYS.includes("sprout_message"));
  });

  it("PROMPT_DEFAULTS has metadata for every key", () => {
    for (const key of PROMPT_KEYS) {
      const meta = PROMPT_DEFAULTS[key];
      assert.ok(meta, `Missing default for ${key}`);
      assert.equal(typeof meta.content, "string");
      assert.equal(typeof meta.description, "string");
      assert.ok(Array.isArray(meta.variables));
      assert.ok(["creation", "system", "mind"].includes(meta.category));
    }
  });

  it("getPrompt returns default when no DB override", async () => {
    const content = await getPrompt("restart_message");
    assert.equal(content, PROMPT_DEFAULTS.restart_message.content);
  });

  it("getPrompt returns DB override when set", async () => {
    const db = await getDb();
    await db.insert(systemPrompts).values({ key: "restart_message", content: "Custom restart" });

    const content = await getPrompt("restart_message");
    assert.equal(content, "Custom restart");
  });

  it("getPrompt substitutes variables", async () => {
    const content = await getPrompt("merge_message", { name: "test-variant" });
    assert.ok(content.includes("test-variant"));
    assert.ok(!content.includes("${name}"));
  });

  it("getPrompt substitutes variables in DB override", async () => {
    const db = await getDb();
    await db
      .insert(systemPrompts)
      .values({ key: "merge_message", content: "Merged: ${name} done" });

    const content = await getPrompt("merge_message", { name: "my-variant" });
    assert.equal(content, "Merged: my-variant done");
  });

  it("getPrompt preserves unmatched variables", async () => {
    const content = await getPrompt("compaction_warning");
    assert.ok(content.includes("${date}"));
  });

  it("getPrompt returns empty string for invalid key", async () => {
    const content = await getPrompt("nonexistent" as any);
    assert.equal(content, "");
  });

  it("getPromptIfCustom returns null when no DB override", async () => {
    const result = await getPromptIfCustom("restart_message");
    assert.equal(result, null);
  });

  it("getPromptIfCustom returns content when DB override exists", async () => {
    const db = await getDb();
    await db.insert(systemPrompts).values({ key: "restart_message", content: "Custom" });

    const result = await getPromptIfCustom("restart_message");
    assert.equal(result, "Custom");
  });

  it("getPromptIfCustom returns null for invalid key", async () => {
    const result = await getPromptIfCustom("nonexistent" as any);
    assert.equal(result, null);
  });

  it("getMindPromptDefaults returns 4 mind-category prompts", async () => {
    const defaults = await getMindPromptDefaults();
    assert.ok("compaction_warning" in defaults);
    assert.ok("compaction_instructions" in defaults);
    assert.ok("reply_instructions" in defaults);
    assert.ok("channel_invite" in defaults);
    assert.equal(Object.keys(defaults).length, 4);
  });

  it("getMindPromptDefaults uses DB overrides", async () => {
    const db = await getDb();
    await db
      .insert(systemPrompts)
      .values({ key: "compaction_warning", content: "Custom compaction" });

    const defaults = await getMindPromptDefaults();
    assert.equal(defaults.compaction_warning, "Custom compaction");
    // Others should still be defaults
    assert.equal(defaults.reply_instructions, PROMPT_DEFAULTS.reply_instructions.content);
  });
});
