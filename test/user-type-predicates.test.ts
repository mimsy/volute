import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExternal, isLocalMind, isMind, isSystemSpirit } from "@volute/api/user-type";

// The point of these predicates (#817) is that they are NOT `user_type === "mind"`.
// Each case below is chosen so that a revert to a raw `=== "mind"` comparison flips
// the assertion — the spirit and external-mind cases are the ones that historically
// got misclassified.

const human = { user_type: "human" as const };
const localMind = { user_type: "mind" as const }; // no `external` flag → local
const externalMind = { user_type: "mind" as const, external: true };
const spirit = { user_type: "spirit" as const };
const puppet = { user_type: "puppet" as const };
// A conversation participant carries `userType` (camelCase) and never an `external` flag.
const spiritParticipant = { userType: "spirit" as const };
const mindParticipant = { userType: "mind" as const };

describe("isMind (rendering / identity)", () => {
  it("is true for a local mind and an external mind", () => {
    assert.equal(isMind(localMind), true);
    assert.equal(isMind(externalMind), true);
    assert.equal(isMind(mindParticipant), true);
  });

  it("is false for the spirit — it has its own icon, not the mind icon", () => {
    // Reverting isMind to include the spirit (e.g. via isLocalMind) breaks this.
    assert.equal(isMind(spirit), false);
    assert.equal(isMind(spiritParticipant), false);
  });

  it("is false for humans and puppets", () => {
    assert.equal(isMind(human), false);
    assert.equal(isMind(puppet), false);
  });
});

describe("isSystemSpirit (the keeper)", () => {
  it("is true only for the system spirit", () => {
    // A revert to `=== "mind"` would make this false — the regression guard.
    assert.equal(isSystemSpirit(spirit), true);
    assert.equal(isSystemSpirit(spiritParticipant), true);
  });

  it("is false for minds, humans, and puppets", () => {
    assert.equal(isSystemSpirit(localMind), false);
    assert.equal(isSystemSpirit(externalMind), false);
    assert.equal(isSystemSpirit(human), false);
    assert.equal(isSystemSpirit(puppet), false);
  });
});

describe("isLocalMind (volute manages this actor directly)", () => {
  it("is true for a locally-managed mind", () => {
    assert.equal(isLocalMind(localMind), true);
    assert.equal(isLocalMind(mindParticipant), true);
  });

  it("is true for the spirit — the spirit is local", () => {
    // `=== "mind"` would return false here. This is the #786 bug shape.
    assert.equal(isLocalMind(spirit), true);
    assert.equal(isLocalMind(spiritParticipant), true);
  });

  it("is false for an external mind — user_type 'mind' but no local dir", () => {
    // `=== "mind"` would return true here, misclassifying the external mind.
    assert.equal(isLocalMind(externalMind), false);
  });

  it("is false for humans and puppets", () => {
    assert.equal(isLocalMind(human), false);
    assert.equal(isLocalMind(puppet), false);
  });
});

describe("isExternal (mind account with no local dir)", () => {
  it("is true only for a mind flagged external", () => {
    assert.equal(isExternal(externalMind), true);
  });

  it("is false for a local mind, the spirit, humans, and puppets", () => {
    assert.equal(isExternal(localMind), false);
    assert.equal(isExternal(spirit), false);
    assert.equal(isExternal(human), false);
    assert.equal(isExternal(puppet), false);
  });
});
