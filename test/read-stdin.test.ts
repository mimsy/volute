import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

describe("readStdin", () => {
  const script = `
    import { readStdin } from "./src/lib/read-stdin.js";
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

  it("returns undefined for empty stdin", async () => {
    const child = execAsync("node", ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
    });
    child.child.stdin!.end();
    const { stdout } = await child;
    assert.equal(stdout, "");
  });
});
