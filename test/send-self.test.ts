import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { run } from "../packages/cli/src/commands/send.js";

describe("send self-DM fast-path", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.VOLUTE_MIND;
  });

  it("errors and exits 1 when a mind sends to its own @self channel", async () => {
    process.env.VOLUTE_MIND = "volute";
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });

    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      await run(["@volute", "reply to my own notice"]);
    } catch {
      // exit mock throws
    } finally {
      console.error = origError;
    }

    assert.equal(exitMock.mock.calls[0]?.arguments[0], 1, "should exit with 1");
    assert.ok(
      errors.some((e) => e.includes("that's yourself")),
      `should explain the self-send is a dead end, got: ${errors.join(" | ")}`,
    );
  });
});
