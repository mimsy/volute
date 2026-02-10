import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadSessionConfig,
  resolveBatch,
  resolveSession,
  type SessionConfig,
} from "../templates/_base/src/lib/sessions.js";

describe("loadSessionConfig", () => {
  it("returns empty config for missing file", () => {
    const config = loadSessionConfig("/nonexistent/sessions.json");
    assert.deepEqual(config, {});
  });

  it("loads valid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
    const path = join(dir, "sessions.json");
    writeFileSync(
      path,
      JSON.stringify({
        rules: [{ channel: "web", session: "web-session" }],
        default: "main",
      }),
    );
    const config = loadSessionConfig(path);
    assert.equal(config.rules?.length, 1);
    assert.equal(config.default, "main");
  });
});

describe("resolveSession", () => {
  it("returns default when no rules match", () => {
    const config: SessionConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "main");
  });

  it("returns 'main' when config has no rules or default", () => {
    assert.equal(resolveSession({}, { channel: "web" }), "main");
  });

  it("matches exact channel", () => {
    const config: SessionConfig = {
      rules: [{ channel: "web", session: "web-session" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web" }), "web-session");
  });

  it("matches exact sender", () => {
    const config: SessionConfig = {
      rules: [{ sender: "alice", session: "alice" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "alice");
    assert.equal(resolveSession(config, { channel: "web", sender: "bob" }), "main");
  });

  it("matches glob pattern in channel", () => {
    const config: SessionConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "discord:12345" }), "discord");
    assert.equal(resolveSession(config, { channel: "web" }), "main");
  });

  it("matches multiple criteria (AND)", () => {
    const config: SessionConfig = {
      rules: [{ channel: "web", sender: "alice", session: "alice-web" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "alice-web");
    assert.equal(resolveSession(config, { channel: "web", sender: "bob" }), "main");
    assert.equal(resolveSession(config, { channel: "cli", sender: "alice" }), "main");
  });

  it("first matching rule wins", () => {
    const config: SessionConfig = {
      rules: [
        { sender: "alice", session: "alice-special" },
        { channel: "web", session: "web-default" },
      ],
      default: "main",
    };
    // Alice on web matches first rule
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "alice-special");
    // Bob on web matches second rule
    assert.equal(resolveSession(config, { channel: "web", sender: "bob" }), "web-default");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
  it("expands ${sender} template variable", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "discord:*", session: "discord-${sender}" }],
      default: "main",
    };
    assert.equal(
      resolveSession(config, { channel: "discord:123", sender: "alice" }),
      "discord-alice",
    );
    assert.equal(resolveSession(config, { channel: "discord:123", sender: "bob" }), "discord-bob");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
  it("expands ${channel} template variable", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "discord:*", session: "chan-${channel}" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "discord:12345" }), "chan-discord:12345");
  });

  it("returns $new literally (server handles generation)", () => {
    const config: SessionConfig = {
      rules: [{ channel: "system:scheduler", session: "$new" }],
      default: "main",
    };
    assert.equal(
      resolveSession(config, { channel: "system:scheduler", sender: "cleanup" }),
      "$new",
    );
  });

  it("handles missing sender in template expansion", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "web", session: "user-${sender}" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web" }), "user-unknown");
  });

  it("scheduler schedule id as sender", () => {
    const config: SessionConfig = {
      rules: [
        { channel: "system:scheduler", sender: "daily-report", session: "daily-report" },
        { channel: "system:scheduler", sender: "cleanup", session: "$new" },
      ],
      default: "main",
    };
    assert.equal(
      resolveSession(config, { channel: "system:scheduler", sender: "daily-report" }),
      "daily-report",
    );
    assert.equal(
      resolveSession(config, { channel: "system:scheduler", sender: "cleanup" }),
      "$new",
    );
    // Unknown schedule falls through to default
    assert.equal(resolveSession(config, { channel: "system:scheduler", sender: "other" }), "main");
  });

  it("rule with no match criteria matches everything", () => {
    const config: SessionConfig = {
      rules: [{ session: "catch-all" }],
      default: "main",
    };
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "catch-all");
    assert.equal(resolveSession(config, {}), "catch-all");
  });

  it("ignores unknown rule keys (no match)", () => {
    const config = {
      rules: [{ chanel: "web", session: "typo-rule" }],
      default: "main",
    } as unknown as SessionConfig;
    // Unknown key "chanel" causes rule to not match
    assert.equal(resolveSession(config, { channel: "web", sender: "alice" }), "main");
  });

  it("sanitizes path traversal in sender template", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ channel: "discord:*", session: "discord-${sender}" }],
      default: "main",
    };
    const result = resolveSession(config, { channel: "discord:123", sender: "../../etc/passwd" });
    assert.ok(!result.includes("/"), `session name should not contain /: ${result}`);
    assert.ok(!result.includes(".."), `session name should not contain ..: ${result}`);
  });

  it("sanitizes path traversal in channel template", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ sender: "alice", session: "chan-${channel}" }],
      default: "main",
    };
    const result = resolveSession(config, { channel: "../../home/SOUL", sender: "alice" });
    assert.ok(!result.includes("/"), `session name should not contain /: ${result}`);
    assert.ok(!result.includes(".."), `session name should not contain ..: ${result}`);
  });

  it("sanitizes backslashes in session names", () => {
    const config: SessionConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ channel: "*", session: "s-${sender}" }],
      default: "main",
    };
    const result = resolveSession(config, { channel: "web", sender: "..\\..\\etc\\passwd" });
    assert.ok(!result.includes("\\"), `session name should not contain \\: ${result}`);
    assert.ok(!result.includes(".."), `session name should not contain ..: ${result}`);
  });
});

describe("resolveBatch", () => {
  it("returns batch minutes for matching rule", () => {
    const config: SessionConfig = {
      rules: [{ channel: "discord:*", session: "discord-feed", batch: 15 }],
      default: "main",
    };
    assert.equal(resolveBatch(config, { channel: "discord:123" }), 15);
  });

  it("returns undefined for matching rule without batch", () => {
    const config: SessionConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    assert.equal(resolveBatch(config, { channel: "discord:123" }), undefined);
  });

  it("returns undefined when no rules match", () => {
    const config: SessionConfig = {
      rules: [{ channel: "discord:*", session: "discord-feed", batch: 15 }],
      default: "main",
    };
    assert.equal(resolveBatch(config, { channel: "web" }), undefined);
  });

  it("returns undefined when config has no rules", () => {
    assert.equal(resolveBatch({}, { channel: "discord:123" }), undefined);
  });

  it("first matching rule wins for batch", () => {
    const config: SessionConfig = {
      rules: [
        { channel: "discord:*", session: "discord-fast", batch: 5 },
        { channel: "discord:*", session: "discord-slow", batch: 30 },
      ],
      default: "main",
    };
    assert.equal(resolveBatch(config, { channel: "discord:123" }), 5);
  });
});
