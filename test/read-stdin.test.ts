import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

describe("readStdin", () => {
  const script = `
    import { readStdin } from "./packages/cli/src/lib/read-stdin.js";
    const result = await readStdin();
    process.stdout.write(result ?? "");
  `;

  it("reads piped stdin", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.write("hello world");
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "hello world");
  });

  it("trims trailing newline", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.write("hello\n");
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "hello");
  });

  it("preserves internal newlines", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.write("line1\nline2\n");
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "line1\nline2");
  });

  it("trims trailing \\r\\n", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.write("hello\r\n");
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "hello");
  });

  it("returns undefined for empty stdin", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "");
  });

  // #872: a pipe nobody closes used to hang the CLI forever with no output.
  describe("open pipe that never closes", () => {
    const guardedScript = `
      import { readStdin } from "./packages/cli/src/lib/read-stdin.js";
      const result = await readStdin({ timeoutMs: 200 });
      process.stdout.write("done:" + (result ?? ""));
    `;

    it("gives up and lets the process exit instead of hanging", async () => {
      const child = execAsync("node", ["--import", "tsx", "-e", guardedScript], {
        cwd: process.cwd(),
        timeout: 20_000,
      });
      // stdin stays open and silent for the whole run — never `.end()`ed.
      const { stdout, stderr } = await child;
      assert.equal(stdout, "done:");
      assert.match(stderr, /No input on stdin after 200ms/);
    });

    // Giving up on a live stream means abandoning something that can still fail.
    // process.stdin is a singleton with no other 'error' handler, so dropping ours
    // would turn a later EPIPE/ECONNRESET into an uncaught exception that kills the
    // command long after readStdin returned — a silent crash in place of the silent
    // hang, which is #864's defect class.
    it("survives an error on the abandoned pipe after giving up", async () => {
      const errorScript = `
        import { readStdin } from "./packages/cli/src/lib/read-stdin.js";
        const result = await readStdin({ timeoutMs: 200 });
        // The abandoned pipe fails after we walked away from it.
        process.stdin.emit(
          "error",
          Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        );
        await new Promise((r) => setTimeout(r, 50));
        process.stdout.write("survived:" + (result ?? ""));
      `;
      const child = execAsync("node", ["--import", "tsx", "-e", errorScript], {
        cwd: process.cwd(),
        timeout: 20_000,
      });
      // stdin stays open — never `.end()`ed.
      const { stdout } = await child;
      assert.equal(stdout, "survived:");
    });

    it("still reads to EOF once a slow producer starts writing", async () => {
      const child = execAsync("node", ["--import", "tsx", "-e", guardedScript], {
        cwd: process.cwd(),
        timeout: 20_000,
      });
      // First byte beats the timeout; the rest arrives long after it would have
      // fired, and must not be truncated.
      child.child.stdin!.write("first");
      setTimeout(() => {
        child.child.stdin!.write(" second");
        child.child.stdin!.end();
      }, 600);
      const { stdout } = await child;
      assert.equal(stdout, "done:first second");
    });
  });
});
