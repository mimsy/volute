import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPrefix } from "../templates/_base/src/lib/format-prefix.js";

const TIME = "2026-08-10 14:02";

describe("channel card in the message prefix", () => {
  it("introduces the channel with its description, rules, and limits", () => {
    const result = formatPrefix(
      {
        channel: "tideline",
        channelName: "tideline",
        sender: "bardo",
        channelInfo: {
          description: "where the day's tide gets logged",
          rules: "keep entries short; one per day",
          charLimit: 500,
          rateLimit: 20,
          rateWindow: 60,
        },
      },
      TIME,
    );

    assert.ok(result.includes("[#tideline — where the day's tide gets logged"));
    assert.ok(result.includes("Rules: keep entries short; one per day"));
    // Both limits read as one line, in the units a mind can act on.
    assert.ok(result.includes("Limits: 500 characters per message; 20 messages per 60s"));
    // The card follows the message prefix rather than replacing it.
    assert.ok(result.startsWith("[Volute: bardo in #tideline"));
  });

  it("omits lines for settings the channel hasn't set", () => {
    const rulesOnly = formatPrefix(
      {
        channel: "quiet",
        channelName: "quiet",
        sender: "mimsy",
        channelInfo: { rules: "be kind" },
      },
      TIME,
    );
    assert.ok(rulesOnly.includes("Rules: be kind"));
    assert.ok(!rulesOnly.includes("Limits:"));
    assert.ok(!rulesOnly.includes("—  "), "no empty description dash");

    const charOnly = formatPrefix(
      { channel: "terse", channelName: "terse", sender: "mimsy", channelInfo: { charLimit: 100 } },
      TIME,
    );
    assert.ok(charOnly.includes("Limits: 100 characters per message"));
    assert.ok(!charOnly.includes("messages per"), "no rate clause without a rate limit");
    assert.ok(!charOnly.includes("Rules:"));
  });

  it("says nothing about a rate limit whose window is missing", () => {
    // A count with no window has no meaning — it must not render as a half-sentence.
    const result = formatPrefix(
      { channel: "odd", channelName: "odd", sender: "mimsy", channelInfo: { rateLimit: 5 } },
      TIME,
    );
    assert.ok(!result.includes("Limits:"));
    assert.ok(!result.includes("[#odd"));
  });

  it("renders no card at all when the channel has set nothing", () => {
    const empty = formatPrefix(
      {
        channel: "bare",
        channelName: "bare",
        sender: "mimsy",
        channelInfo: { description: null, rules: null, charLimit: null },
      },
      TIME,
    );
    assert.ok(!empty.includes("[#bare"));

    // And no card when the daemon sent no channelInfo (an unlimited channel, or a DM).
    const none = formatPrefix({ channel: "@alice", sender: "alice", isDM: true }, TIME);
    assert.ok(!none.includes("Rules:"));
    assert.ok(!none.includes("Limits:"));
  });

  it("does not double the # when the channel name already carries one", () => {
    const result = formatPrefix(
      { channel: "#hashed", sender: "mimsy", channelInfo: { rules: "one" } },
      TIME,
    );
    assert.ok(result.includes("[#hashed"));
    assert.ok(!result.includes("##hashed"));
  });
});
