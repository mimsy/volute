import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldBootEntry } from "../packages/daemon/src/daemon.js";

/**
 * The daemon boot loop restores two different things: processes (for running
 * minds) and clocks (for sleeping ones). #865 was caused by conflating them —
 * filtering on `running` alone meant a sleeping mind, which sleep persists as
 * `running = 0`, never reached the branch that reloads its schedules.
 *
 * These pin the claims the comment on `shouldBootEntry` makes, because those are
 * exactly the claims that rot.
 */
describe("daemon boot filter (#865)", () => {
  const asleep = (names: string[]) => (name: string) => names.includes(name);
  const none = () => false;

  it("includes a running mind", () => {
    assert.equal(shouldBootEntry({ name: "a", running: true }, none), true);
  });

  it("includes a sleeping mind even though sleep persists running = 0", () => {
    assert.equal(shouldBootEntry({ name: "mimsy", running: false }, asleep(["mimsy"])), true);
  });

  it("excludes a mind that was stopped and never slept", () => {
    // `stopMindFull` unloads its schedules on purpose; a stopped mind's clock is
    // meant to be silent, and restoring it could restart the process via a
    // trigger-wake schedule.
    assert.equal(shouldBootEntry({ name: "stopped", running: false }, none), false);
  });

  it("excludes the spirit, running or not", () => {
    assert.equal(shouldBootEntry({ name: "s", running: true, mindType: "spirit" }, none), false);
    assert.equal(
      shouldBootEntry({ name: "s", running: false, mindType: "spirit" }, asleep(["s"])),
      false,
    );
  });

  it("includes a running variant but never restores a clock for a sleeping one", () => {
    // Variants have no independent schedules or sleep state.
    assert.equal(shouldBootEntry({ name: "v", running: true, parent: "a" }, none), true);
    assert.equal(
      shouldBootEntry({ name: "v", running: false, parent: "a" }, asleep(["v"])),
      false,
      "a variant is never brought back for its clock alone",
    );
  });
});
