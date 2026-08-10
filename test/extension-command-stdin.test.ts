import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommand } from "@volute/extensions";
import { toCommandInfo } from "../packages/daemon/src/lib/extensions.js";
import { createCommands as intentionCommands } from "../packages/extensions/intentions/src/commands.js";
import { createCommands as pageCommands } from "../packages/extensions/pages/src/commands.js";

/**
 * #872: the CLI drained stdin to EOF before dispatching *every* extension command,
 * so any caller whose stdin was a pipe nobody closes hung forever with no output.
 * Commands now opt in with `stdin: true`, and the CLI reads stdin only for those.
 */
describe("extension command stdin opt-in", () => {
  it("carries `stdin` through to the CLI over /api/extensions/commands", () => {
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
