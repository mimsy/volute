import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";
import { createIdentityWatch } from "../templates/_base/src/lib/identity-watch.js";
import { loadSystemPrompt } from "../templates/_base/src/lib/startup.js";

/**
 * An identity edit (SOUL.md / MEMORY.md / VOLUTE.md) used to restart a claude mind within
 * seconds — and every restart rewrote the whole context into the prompt cache under a new
 * prefix. Now the prompt is rebuilt per SDK stream, so the edit loads at the next session
 * boundary (idle reap → resume, rotation, sleep, restart) and the mind is told so on the
 * edit's own tool result.
 */

const cwd = "/home/mind";
const templatesRoot = resolve(fileURLToPath(import.meta.url), "../../templates");

type FileHook = (input: { tool_input?: { file_path?: string } }) => Promise<{
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
}>;

// The claude modules import lib/identity-watch.ts and lib/logger.ts, which only exist once
// _base and claude are layered together at mind-create time — so compose and import them.
let composedDir: string;
let createIdentityNoticeHook: (cwd: string, sessionIdleMinutes: number) => FileHook;
let createSystemPromptSource: (load: () => string) => {
  current(): string;
  forNewStream(): string;
};

before(async () => {
  composedDir = composeTemplate(templatesRoot, "claude").composedDir;
  ({ createIdentityNoticeHook } = await import(
    resolve(composedDir, "src/lib/hooks/identity-notice.js")
  ));
  ({ createSystemPromptSource } = await import(resolve(composedDir, "src/lib/system-prompt.js")));
});

after(() => {
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
});

async function noteFor(hook: FileHook, filePath?: string): Promise<string | undefined> {
  const out = await hook({ tool_input: filePath ? { file_path: filePath } : {} });
  return out.hookSpecificOutput?.additionalContext;
}

/** The body of agent.ts's createStream(), for source pins. */
function createStreamSource(): string {
  const agent = readFileSync(resolve(templatesRoot, "claude/src/agent.ts"), "utf-8");
  const start = agent.indexOf("function createStream(");
  assert.notEqual(start, -1, "createStream not found in agent.ts");
  return agent.slice(start, agent.indexOf("\n  }\n", start));
}

describe("claude system prompt source", () => {
  const origCwd = process.cwd();
  const scratch: string[] = [];
  afterEach(() => {
    process.chdir(origCwd);
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeMind(files: Record<string, string>): string {
    const dir = mkdtempSync(resolve(tmpdir(), "deferred-reload-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(resolve(dir, "home", name), content);
    }
    return dir;
  }

  it("a new stream picks up an identity edit made during the previous one", () => {
    const dir = makeMind({ "SOUL.md": "I am soul", "MEMORY.md": "remember: before" });
    process.chdir(dir);
    const source = createSystemPromptSource(() => loadSystemPrompt());
    assert.ok(source.forNewStream().includes("remember: before"));

    writeFileSync(resolve(dir, "home/MEMORY.md"), "remember: after");
    // Mid-session: the live stream's prompt is untouched by the edit.
    assert.ok(source.current().includes("remember: before"), "edit must not reach a live stream");

    // Session boundary (reap → resume, rotation): the new stream is built from disk.
    const next = source.forNewStream();
    assert.ok(next.includes("remember: after"), "the next stream loads the edit");
    assert.ok(!next.includes("remember: before"));
    assert.equal(source.current(), next);
  });

  it("keeps the last good prompt when SOUL.md is unreadable at a boundary", () => {
    const dir = makeMind({ "SOUL.md": "I am soul" });
    process.chdir(dir);
    const source = createSystemPromptSource(() => loadSystemPrompt());
    rmSync(resolve(dir, "home/SOUL.md"));
    // Used to be process.exit(1) — fatal if it happened at a mid-life stream start.
    assert.throws(() => loadSystemPrompt(), /Could not read soul file/);
    assert.ok(source.forNewStream().includes("I am soul"));
  });

  it("still fails at startup when the first build fails", () => {
    const dir = makeMind({});
    process.chdir(dir);
    assert.throws(() => createSystemPromptSource(() => loadSystemPrompt()), /soul file/);
  });
});

describe("claude template identity-change notice", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeHome(files: Record<string, string> = { "SOUL.md": "soul", "MEMORY.md": "mem" }) {
    const home = mkdtempSync(resolve(tmpdir(), "identity-notice-"));
    scratch.push(home);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(resolve(home, name), content);
    }
    return home;
  }

  // The hook ignores its input — it compares files on disk against its baseline — so a
  // Bash tool call is modelled by writing the file directly.
  const toolCall = (hook: FileHook) => noteFor(hook, "whatever");

  it("says nothing while identity files match what the stream was built from", async () => {
    const home = makeHome();
    const hook = createIdentityNoticeHook(home, 30);
    assert.equal(await toolCall(hook), undefined);
    writeFileSync(resolve(home, "notes.md"), "not identity");
    assert.equal(await toolCall(hook), undefined);
  });

  it("notices an edit made by any tool, Bash included, and says when it loads", async () => {
    for (const file of ["SOUL.md", "MEMORY.md", "VOLUTE.md"]) {
      const home = makeHome();
      const hook = createIdentityNoticeHook(home, 30);
      writeFileSync(resolve(home, file), "edited");
      const note = await toolCall(hook);
      assert.ok(note, `${file} should earn a note`);
      assert.ok(note.startsWith(`${file} changed on disk`), note);
      assert.match(note, /next boundary/);
      assert.match(note, /resumes after resting 30 idle minutes/);
      assert.match(note, /volute mind restart/, "the mind is told how to make it live now");
      assert.doesNotMatch(note, /older version/, "no stale-doc line without a stale doc");
    }
  });

  it("notes once per stream, and again on the next stream", async () => {
    const home = makeHome();
    const stream1 = createIdentityNoticeHook(home, 30);
    writeFileSync(resolve(home, "MEMORY.md"), "edit 1");
    assert.ok(await toolCall(stream1));
    writeFileSync(resolve(home, "SOUL.md"), "edit 2");
    assert.equal(await toolCall(stream1), undefined, "no repeat within a stream");
    // A new stream is built from the edited files, so they're its baseline.
    const stream2 = createIdentityNoticeHook(home, 30);
    assert.equal(await toolCall(stream2), undefined, "the new stream already has the edit");
    writeFileSync(resolve(home, "MEMORY.md"), "edit 3");
    assert.ok(await toolCall(stream2), "a later edit is pending again");
  });

  it("names the old doc when the mind's CLAUDE.md still promises a restart", async () => {
    const home = makeHome({
      "SOUL.md": "soul",
      "CLAUDE.md": "**Editing any identity file triggers an automatic restart** — ...",
    });
    const hook = createIdentityNoticeHook(home, 30);
    writeFileSync(resolve(home, "SOUL.md"), "edited");
    assert.match((await toolCall(hook)) ?? "", /older version of your framework/);
  });

  it("doesn't promise an idle boundary when reaping is disabled", async () => {
    const home = makeHome();
    const hook = createIdentityNoticeHook(home, 0);
    writeFileSync(resolve(home, "SOUL.md"), "edited");
    const note = await toolCall(hook);
    assert.ok(note);
    assert.doesNotMatch(note, /idle/);
  });
});

// There is no seam to intercept `query()` in a unit test, so pin the source: the prompt
// must be rebuilt where a stream is created, and nothing may restart the mind on an edit.
describe("template wiring", () => {
  const read = (p: string) => readFileSync(resolve(templatesRoot, p), "utf-8");

  it("claude rebuilds the system prompt per SDK stream", () => {
    assert.match(createStreamSource(), /systemPrompt:\s*systemPrompt\.forNewStream\(\)/);
    assert.doesNotMatch(read("claude/src/agent.ts"), /options\.systemPrompt\b/);
  });

  it("claude registers the notice hook per stream, for every tool, with history emit", () => {
    // Per stream, so its baseline is the files this stream's prompt was built from.
    assert.match(
      createStreamSource(),
      /matcher:\s*"\.\*",\s*hooks:\s*\[\s*wrapHookWithEmit\(\s*createIdentityNoticeHook\(/,
    );
  });

  it("claude commits a cut-short turn's edits on shutdown (mid-turn self-restart)", () => {
    const shutdown = read("claude/src/server.ts").split("setupShutdown(")[1] ?? "";
    assert.match(shutdown, /mind\.flushFileChanges\(\)/);
  });

  it("claude does not restart the mind on an identity edit", () => {
    for (const file of ["claude/src/agent.ts", "claude/src/server.ts"]) {
      const src = read(file);
      assert.doesNotMatch(src, /daemonRestart/, `${file} restarts the mind`);
      assert.doesNotMatch(src, /onIdentityReload|shouldRequestReload/, `${file} still reloads`);
    }
  });

  it("codex relies on its per-turn prompt refresh instead of a restart", () => {
    const agent = read("codex/src/agent.ts");
    assert.doesNotMatch(agent, /daemonRestart/);
    const start = agent.indexOf("async function runTurn(");
    assert.notEqual(start, -1);
    assert.match(agent.slice(start, start + 2000), /refreshSystemPrompt\(\);/);
  });

  it("codex keeps and reports the last prompt it wrote, not the startup one", () => {
    const agent = read("codex/src/agent.ts");
    // One read of the startup prompt, to seed the running one; everything else (the
    // failed-rebuild fallback, the context panel) uses the refreshed prompt.
    assert.equal(agent.match(/options\.systemPrompt\b/g)?.length, 1);
    assert.match(agent, /let systemPrompt = options\.systemPrompt;/);
  });
});

// pi still restarts after a turn that edited an identity file (#998); it keeps the latch.
describe("identity watch (pi)", () => {
  it("does not request a reload without an identity-file edit", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("notes/todo.md");
    assert.equal(watch.shouldRequestReload(), false);
  });

  it("requests a reload for each of the system prompt's source files", () => {
    for (const file of ["SOUL.md", "MEMORY.md", "VOLUTE.md"]) {
      const watch = createIdentityWatch(cwd);
      watch.noteFileChange(file);
      assert.equal(watch.shouldRequestReload(), true, `${file} should request a reload`);
    }
  });

  it("ignores identity-named files outside the mind's cwd", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("/etc/SOUL.md");
    watch.noteFileChange("/home/mind-backup/SOUL.md");
    assert.equal(watch.shouldRequestReload(), false);
  });

  it("latches: fires at most once so a failed restart doesn't loop", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("SOUL.md");
    assert.equal(watch.shouldRequestReload(), true, "first check should request the reload");
    assert.equal(watch.shouldRequestReload(), false, "subsequent checks must not re-fire");
    watch.noteFileChange("VOLUTE.md");
    assert.equal(watch.shouldRequestReload(), false, "latch stays closed after the first request");
  });
});
