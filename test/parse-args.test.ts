import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/parse-args.js";

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

  it("ignores unknown flags", () => {
    const result = parseArgs(["--unknown", "value", "pos"], {
      known: { type: "string" },
    });
    // --unknown is skipped; "value" and "pos" become positional
    assert.deepStrictEqual(result.positional, ["value", "pos"]);
    assert.equal(result.flags.known, undefined);
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
});
