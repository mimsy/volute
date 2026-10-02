import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canReadMindHistory } from "../packages/web/src/ui/lib/history-access.js";

// The web UI must not ask for history the daemon will refuse (#1269).
describe("canReadMindHistory", () => {
  it("lets an admin read any mind's history", () => {
    assert.equal(canReadMindHistory({ role: "admin", username: "ada" }, "lyra"), true);
  });

  it("lets a user read their own", () => {
    assert.equal(canReadMindHistory({ role: "user", username: "lyra" }, "lyra"), true);
  });

  it("does not let a non-admin read another mind's", () => {
    assert.equal(canReadMindHistory({ role: "user", username: "sam" }, "lyra"), false);
    assert.equal(canReadMindHistory({ role: "pending", username: "sam" }, "lyra"), false);
    assert.equal(canReadMindHistory(null, "lyra"), false);
  });
});
