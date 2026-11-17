import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommand } from "@volute/extensions";
import { createCommands as feedbackCommands } from "../packages/extensions/feedback/src/commands.js";
import {
  clipNotice,
  commandInput,
  NOTICE_MAX,
  toCommandInfo,
} from "../packages/daemon/src/lib/extensions.js";
import { createCommands as intentionCommands } from "../packages/extensions/intentions/src/commands.js";
import { createCommands as pageCommands } from "../packages/extensions/pages/src/commands.js";

/**
 * #872: the CLI drained stdin to EOF before dispatching *every* extension command,
 * so any caller whose stdin was a pipe nobody closes hung forever with no output.
 * Commands now opt in with `stdin: true`, and the CLI reads stdin only for those.
 */
describe("extension command stdin opt-in", () => {
  it("carries `stdin` through to the CLI over /api/v1/extensions/commands", () => {
    const cmd: ExtensionCommand = {
      description: "takes piped input",
      stdin: true,
      handler: async () => ({ output: "" }),
    };
    const info = toCommandInfo(cmd);
    assert.equal(info.stdin, true);
    assert.equal("handler" in info, false);
  });

  it("leaves `stdin` unset for commands that do not declare it", () => {
    const info = toCommandInfo({
      description: "no piped input",
      handler: async () => ({ output: "" }),
    });
    assert.equal(info.stdin, undefined);
  });

  // The opt-in only helps if it stays in sync with the handlers. A handler that
  // reads ctx.stdin without declaring it silently ignores piped input; one that
  // declares it without reading it makes its callers wait on stdin for nothing.
  for (const [ext, commands] of [
    ["pages", pageCommands()],
    ["intentions", intentionCommands()],
    ["feedback", feedbackCommands()],
  ] as const) {
    it(`${ext}: declares stdin on exactly the handlers that read it`, () => {
      for (const [name, cmd] of Object.entries(commands)) {
        const readsStdin = /\bstdin\b/.test(cmd.handler.toString());
        assert.equal(
          cmd.stdin === true,
          readsStdin,
          readsStdin
            ? `volute ${ext} ${name} reads stdin but does not declare \`stdin: true\``
            : `volute ${ext} ${name} declares \`stdin: true\` but never reads it`,
        );
      }
    });
  }

  it("covers the five handlers the issue identified", () => {
    const declared = [
      ...Object.entries(pageCommands()).map(([n, c]) => ["pages", n, c] as const),
      ...Object.entries(intentionCommands()).map(([n, c]) => ["intentions", n, c] as const),
    ]
      .filter(([, , c]) => c.stdin === true)
      .map(([ext, n]) => `${ext} ${n}`)
      .sort();
    assert.deepEqual(declared, [
      "intentions add",
      "intentions fulfill",
      "intentions release",
      "pages comment",
      "pages write",
    ]);
  });
});

/**
 * A `raw` command wraps a parser of its own (repeated flags, flags taking two values),
 * which declared `args`/`flags` cannot describe: its handler gets the argv whole.
 */
describe("raw extension commands", () => {
  const argv = [
    "new",
    "--link",
    "wiki/a",
    "--link",
    "wiki/b",
    "--quote",
    "wiki/a",
    "exact",
    "body",
  ];

  it("hands a raw command its whole argv, unparsed", () => {
    assert.deepEqual(commandInput({ raw: true }, argv), { args: {}, flags: {}, rest: argv });
  });

  it("still parses a command that does not declare `raw`", () => {
    const parsed = commandInput(
      {
        args: [{ name: "verb", description: "" }],
        flags: { link: { type: "string", description: "" } },
      },
      ["new", "--link", "wiki/a"],
    );
    assert.deepEqual(parsed, { args: { verb: "new" }, flags: { link: "wiki/a" }, rest: [] });
  });

  it("carries `raw` through to the CLI, which must skip its own checking", () => {
    const info = toCommandInfo({
      description: "",
      raw: true,
      handler: async () => ({ output: "" }),
    });
    assert.equal(info.raw, true);
  });
});

describe("an extension's notice", () => {
  it("is left alone when it fits", () => {
    assert.equal(clipNotice("a comment on your note"), "a comment on your note");
  });

  it("is cut at a word and marked, never mid-word", () => {
    const long = `${"word ".repeat(120)}ending`;
    const cut = clipNotice(long);
    assert.ok(cut.length <= NOTICE_MAX);
    assert.match(cut, /word…$/);
  });

  it("is cut hard when there is no word to cut at", () => {
    const cut = clipNotice("x".repeat(900));
    assert.equal(cut.length, NOTICE_MAX);
    assert.ok(cut.endsWith("…"));
  });
});
