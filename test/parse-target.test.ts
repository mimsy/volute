import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTarget } from "../src/lib/parse-target.js";

describe("parseTarget", () => {
  it("@lion → volute DM", () => {
    const result = parseTarget("@lion");
    assert.deepStrictEqual(result, {
      platform: "volute",
      identifier: "@lion",
      uri: "volute:@lion",
      isDM: true,
    });
  });

  it("animal-chat → volute channel", () => {
    const result = parseTarget("animal-chat");
    assert.deepStrictEqual(result, {
      platform: "volute",
      identifier: "animal-chat",
      uri: "volute:animal-chat",
      isDM: false,
    });
  });

  it("volute:@lion → explicit volute DM", () => {
    const result = parseTarget("volute:@lion");
    assert.deepStrictEqual(result, {
      platform: "volute",
      identifier: "@lion",
      uri: "volute:@lion",
      isDM: true,
    });
  });

  it("discord:server/channel → discord channel", () => {
    const result = parseTarget("discord:server/channel");
    assert.deepStrictEqual(result, {
      platform: "discord",
      identifier: "server/channel",
      uri: "discord:server/channel",
      isDM: false,
    });
  });

  it("discord:@user → discord DM", () => {
    const result = parseTarget("discord:@user");
    assert.deepStrictEqual(result, {
      platform: "discord",
      identifier: "@user",
      uri: "discord:@user",
      isDM: true,
    });
  });

  it("slack:workspace/channel → slack channel", () => {
    const result = parseTarget("slack:workspace/channel");
    assert.deepStrictEqual(result, {
      platform: "slack",
      identifier: "workspace/channel",
      uri: "slack:workspace/channel",
      isDM: false,
    });
  });
});
