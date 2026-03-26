import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../packages/cli/src/lib/parse-args.js";
import { parseCommandArgs } from "../packages/daemon/src/lib/extensions.js";

describe("parseArgs", () => {
  it("extracts positional args", () => {
    const result = parseArgs(["foo", "bar"], {});
    assert.deepStrictEqual(result.positional, ["foo", "bar"]);
  });

  it("extracts string flags", () => {
    const result = parseArgs(["--name", "hello"], {
      name: { type: "string" },
    });
    assert.equal(result.flags.name, "hello");
    assert.deepStrictEqual(result.positional, []);
  });

  it("extracts number flags", () => {
    const result = parseArgs(["--port", "8080"], {
      port: { type: "number" },
    });
    assert.equal(result.flags.port, 8080);
  });

  it("extracts boolean flags", () => {
    const result = parseArgs(["--json"], {
      json: { type: "boolean" },
    });
    assert.equal(result.flags.json, true);
  });

  it("defaults boolean flags to false", () => {
    const result = parseArgs([], {
      json: { type: "boolean" },
    });
    assert.equal(result.flags.json, false);
  });

  it("defaults string and number flags to undefined", () => {
    const result = parseArgs([], {
      name: { type: "string" },
      port: { type: "number" },
    });
    assert.equal(result.flags.name, undefined);
    assert.equal(result.flags.port, undefined);
  });

  it("mixes positional and flags", () => {
    const result = parseArgs(["myproject", "--port", "3000", "--json"], {
      port: { type: "number" },
      json: { type: "boolean" },
    });
    assert.deepStrictEqual(result.positional, ["myproject"]);
    assert.equal(result.flags.port, 3000);
    assert.equal(result.flags.json, true);
  });

  it("warns on unknown flags and skips them", () => {
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      const result = parseArgs(["--unknown", "value", "pos"], {
        known: { type: "string" },
      });
      // --unknown is skipped; "value" and "pos" become positional
      assert.deepStrictEqual(result.positional, ["value", "pos"]);
      assert.equal(result.flags.known, undefined);
      assert.ok(errors.some((e) => e.includes("unknown flag --unknown")));
    } finally {
      console.error = origError;
    }
  });

  it("handles flag at end without value", () => {
    const result = parseArgs(["--name"], {
      name: { type: "string" },
    });
    assert.equal(result.flags.name, undefined);
  });

  it("handles multiple positional args with flags interspersed", () => {
    const result = parseArgs(["a", "--json", "b"], {
      json: { type: "boolean" },
    });
    assert.deepStrictEqual(result.positional, ["a", "b"]);
    assert.equal(result.flags.json, true);
  });

  it("handles empty args", () => {
    const result = parseArgs([], {
      name: { type: "string" },
      port: { type: "number" },
      json: { type: "boolean" },
    });
    assert.deepStrictEqual(result.positional, []);
    assert.equal(result.flags.name, undefined);
    assert.equal(result.flags.port, undefined);
    assert.equal(result.flags.json, false);
  });

  it("detects --help flag", () => {
    const result = parseArgs(["--help"], { name: { type: "string" } });
    assert.equal(result.help, true);
  });

  it("detects -h flag", () => {
    const result = parseArgs(["-h"], { name: { type: "string" } });
    assert.equal(result.help, true);
  });

  it("defaults help to false", () => {
    const result = parseArgs(["foo"], {});
    assert.equal(result.help, false);
  });

  it("detects --help mixed with other args", () => {
    const result = parseArgs(["foo", "--help", "--name", "bar"], {
      name: { type: "string" },
    });
    assert.equal(result.help, true);
    assert.ok(!result.positional.includes("--help"));
    assert.equal(result.flags.name, "bar");
  });
});

describe("parseCommandArgs", () => {
  it("maps positional args to named defs", () => {
    const result = parseCommandArgs(
      ["hello", "world"],
      [
        { name: "title", required: true, description: "Title" },
        { name: "content", description: "Content" },
      ],
      {},
    );
    assert.equal(result.args.title, "hello");
    assert.equal(result.args.content, "world");
    assert.deepStrictEqual(result.rest, []);
  });

  it("collects excess positionals into rest", () => {
    const result = parseCommandArgs(
      ["hello", "extra1", "extra2"],
      [{ name: "title", required: true, description: "Title" }],
      {},
    );
    assert.equal(result.args.title, "hello");
    assert.deepStrictEqual(result.rest, ["extra1", "extra2"]);
  });

  it("parses boolean flags", () => {
    const result = parseCommandArgs(["--shared"], [], {
      shared: { type: "boolean", description: "Shared" },
    });
    assert.equal(result.flags.shared, true);
  });

  it("defaults boolean flags to false", () => {
    const result = parseCommandArgs([], [], { shared: { type: "boolean", description: "Shared" } });
    assert.equal(result.flags.shared, false);
  });

  it("parses string flags", () => {
    const result = parseCommandArgs(["--author", "alice"], [], {
      author: { type: "string", description: "Author" },
    });
    assert.equal(result.flags.author, "alice");
  });

  it("parses number flags", () => {
    const result = parseCommandArgs(["--limit", "5"], [], {
      limit: { type: "number", description: "Limit" },
    });
    assert.equal(result.flags.limit, 5);
  });

  it("returns undefined for NaN number flags", () => {
    const result = parseCommandArgs(["--limit", "abc"], [], {
      limit: { type: "number", description: "Limit" },
    });
    assert.equal(result.flags.limit, undefined);
  });

  it("handles missing optional args as undefined", () => {
    const result = parseCommandArgs(
      ["hello"],
      [
        { name: "title", required: true, description: "Title" },
        { name: "content", description: "Content" },
      ],
      {},
    );
    assert.equal(result.args.title, "hello");
    assert.equal(result.args.content, undefined);
  });

  it("handles flag at end without value", () => {
    const result = parseCommandArgs(["--limit"], [], {
      limit: { type: "number", description: "Limit" },
    });
    assert.equal(result.flags.limit, undefined);
  });

  it("mixes positional args and flags", () => {
    const result = parseCommandArgs(
      ["my-title", "--limit", "10", "my-content"],
      [
        { name: "title", required: true, description: "Title" },
        { name: "content", description: "Content" },
      ],
      { limit: { type: "number", description: "Limit" } },
    );
    assert.equal(result.args.title, "my-title");
    assert.equal(result.args.content, "my-content");
    assert.equal(result.flags.limit, 10);
  });

  it("skips unknown flags", () => {
    const result = parseCommandArgs(
      ["hello", "--unknown", "--shared"],
      [{ name: "title", required: true, description: "Title" }],
      { shared: { type: "boolean", description: "Shared" } },
    );
    assert.equal(result.args.title, "hello");
    assert.equal(result.flags.shared, true);
  });
});
