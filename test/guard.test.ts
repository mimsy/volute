import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { voluteHome } from "../src/lib/registry.js";

describe("voluteHome guard", () => {
  it("VOLUTE_HOME is set to a temp directory (not real home)", () => {
    const home = process.env.VOLUTE_HOME;
    assert.ok(home, "VOLUTE_HOME must be set in test environment");
    assert.ok(
      !home.startsWith(homedir()) || home.includes("volute-test"),
      `VOLUTE_HOME should not point to the real home directory, got: ${home}`,
    );
  });

  it("voluteHome() returns the temp directory", () => {
    assert.equal(voluteHome(), process.env.VOLUTE_HOME);
  });
});
