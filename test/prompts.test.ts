import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  getMindPromptDefaults,
  getPrompt,
  getPromptIfCustom,
  MEMORY_PLACEHOLDER_MARKER,
  ORIENTATION_MARKER,
  PROMPT_DEFAULTS,
  PROMPT_KEYS,
} from "../packages/daemon/src/lib/prompts.js";
import { systemPrompts } from "../packages/daemon/src/lib/schema.js";
import { DEFAULT_PROMPTS } from "../templates/_base/src/lib/startup.js";

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
    assert.ok(PROMPT_KEYS.includes("event_instructions"));
    assert.ok(PROMPT_KEYS.includes("channel_invite"));
    assert.ok(PROMPT_KEYS.includes("restart_message"));
    assert.ok(PROMPT_KEYS.includes("merge_message"));
    assert.ok(PROMPT_KEYS.includes("sprout_message"));
    assert.ok(PROMPT_KEYS.includes("pre_sleep"));
    assert.ok(PROMPT_KEYS.includes("wake_summary"));
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

  it("seed_soul contains the orientation marker used by sprout and seed-check", () => {
    assert.ok(PROMPT_DEFAULTS.seed_soul.content.includes(ORIENTATION_MARKER));
  });

  it("mind prompt defaults match the template's, which is what minds actually receive", async () => {
    // These prompts live in two places: PROMPT_DEFAULTS (what the Prompt Library UI edits) and
    // DEFAULT_PROMPTS in templates/_base/src/lib/startup.ts (what a mind falls back to when its
    // prompts.json lacks the key — i.e. what every new mind is actually given). Nothing else
    // keeps them in sync, so re-wording one silently leaves minds on the other's text.
    // KNOWN DRIFT, pre-existing: the two channel_invite prompts are not variants of one text —
    // they are different prompts with different variables (the template's still describes
    // .config/routes.json rules and ${suggestedSession}; the daemon's is a rewritten "New
    // channel" notice with ${heldLine}/${limit}). One of them is stale. Excluded rather than
    // silently skipped, so this is a documented debt and not a hole in the guard.
    const KNOWN_DRIFT = new Set(["channel_invite"]);

    let compared = 0;
    for (const [key, content] of Object.entries(await getMindPromptDefaults())) {
      const templateDefault = (DEFAULT_PROMPTS as Record<string, string | undefined>)[key];
      if (templateDefault === undefined) continue; // daemon-side only; not carried by templates
      if (KNOWN_DRIFT.has(key)) continue;
      compared++;
      assert.equal(
        templateDefault,
        content,
        `${key} has drifted between prompts.ts and templates/_base/src/lib/startup.ts`,
      );
    }
    assert.ok(compared > 0, "expected to compare at least one shared prompt");
  });

  it("compaction_warning states the memory cost and teaches consolidation, not appending (#569)", () => {
    // Compaction is when the memory tax bites; the warning must carry the current
    // MEMORY.md size and point away from append-forever growth.
    const { content, variables } = PROMPT_DEFAULTS.compaction_warning;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${memory_size} in prompt
    assert.ok(content.includes("${memory_size}"));
    assert.ok(variables.includes("memory_size"));
    assert.match(content, /consolidate rather than append/);
    // The old text told minds to save things *to* MEMORY.md — the backwards direction.
    assert.ok(!content.includes("(MEMORY.md"));
  });

  it("stamped prompts.json matches the template defaults minds fall back to", () => {
    // .init/.config/prompts.json is copied into new minds at creation (then
    // mind-owned). At stamp time it must equal DEFAULT_PROMPTS, or new minds get
    // different text depending on whether the key survived in their prompts.json.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const stamped = JSON.parse(
      readFileSync(resolve(here, "../templates/_base/.init/.config/prompts.json"), "utf-8"),
    ) as Record<string, string>;
    for (const [key, content] of Object.entries(stamped)) {
      assert.equal(
        content,
        (DEFAULT_PROMPTS as Record<string, string | undefined>)[key],
        `${key} has drifted between .init/.config/prompts.json and DEFAULT_PROMPTS`,
      );
    }
  });

  it("placeholder MEMORY.md template contains the marker used by sprout and seed-check", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const placeholder = readFileSync(resolve(here, "../templates/_base/.init/MEMORY.md"), "utf-8");
    assert.ok(
      placeholder.includes(MEMORY_PLACEHOLDER_MARKER),
      "template MEMORY.md must contain MEMORY_PLACEHOLDER_MARKER so the sprout gate can detect it",
    );
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal ${name} in prompt
    assert.ok(!content.includes("${name}"));
  });

  it("getPrompt substitutes variables in DB override", async () => {
    const db = await getDb();
    await db
      .insert(systemPrompts)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal ${name} in prompt
      .values({ key: "merge_message", content: "Merged: ${name} done" });

    const content = await getPrompt("merge_message", { name: "my-variant" });
    assert.equal(content, "Merged: my-variant done");
  });

  it("getPrompt preserves unmatched variables", async () => {
    const content = await getPrompt("compaction_warning");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal ${date} in prompt
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

  it("getMindPromptDefaults returns 5 mind-category prompts", async () => {
    const defaults = await getMindPromptDefaults();
    assert.ok("compaction_warning" in defaults);
    assert.ok("compaction_instructions" in defaults);
    assert.ok("reply_instructions" in defaults);
    assert.ok("event_instructions" in defaults);
    assert.ok("channel_invite" in defaults);
    assert.equal(Object.keys(defaults).length, 5);
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
