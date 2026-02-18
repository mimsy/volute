import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadRoutingConfig,
  type ResolvedRoute,
  type RoutingConfig,
  resolveRoute,
  resolveSessionConfig,
} from "../templates/_base/src/lib/routing.js";

/** Asserts route is mind-destined and returns the narrowed type. */
function expectMind(route: ResolvedRoute) {
  assert.equal(route.destination, "mind");
  return route as Extract<ResolvedRoute, { destination: "mind" }>;
}

describe("loadRoutingConfig", () => {
  it("returns empty config for missing file", () => {
    const config = loadRoutingConfig("/nonexistent/routes.json");
    assert.deepEqual(config, {});
  });

  it("loads valid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
    const path = join(dir, "routes.json");
    writeFileSync(
      path,
      JSON.stringify({
        rules: [{ channel: "web", session: "web-session" }],
        default: "main",
      }),
    );
    const config = loadRoutingConfig(path);
    assert.equal(config.rules?.length, 1);
    assert.equal(config.default, "main");
  });

  it("normalizes flat array to { rules: [...] }", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
    const path = join(dir, "routes.json");
    writeFileSync(
      path,
      JSON.stringify([
        { channel: "system", session: "system" },
        { channel: "volute:@aswever", session: "volute-@aswever" },
      ]),
    );
    const config = loadRoutingConfig(path);
    assert.equal(config.rules?.length, 2);
    assert.equal(config.rules?.[0].channel, "system");
    assert.equal(config.rules?.[1].session, "volute-@aswever");
  });
});

describe("resolveRoute", () => {
  // --- Basic routing ---

  it("returns agent destination with default session when no config", () => {
    const r = expectMind(resolveRoute({}, { channel: "web" }));
    assert.equal(r.session, "main");
  });

  it("returns 'main' when config has no rules or default", () => {
    const r = expectMind(resolveRoute({}, { channel: "web" }));
    assert.equal(r.session, "main");
  });

  it("returns agent destination for rules without destination field", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = expectMind(resolveRoute(config, { channel: "discord:123" }));
    assert.equal(r.session, "discord");
  });

  it("returns file destination when rule specifies it", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:logs-*", destination: "file", path: "home/inbox/discord.md" }],
      default: "main",
    };
    const route = resolveRoute(config, { channel: "discord:logs-123" });
    assert.equal(route.destination, "file");
    assert.equal(route.path, "home/inbox/discord.md");
  });

  it("falls through to default when no rules match", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "fallback",
    };
    const r = expectMind(resolveRoute(config, { channel: "web" }));
    assert.equal(r.session, "fallback");
  });

  // --- Match criteria ---

  it("matches exact channel", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "web", session: "web-session" }],
      default: "main",
    };
    assert.equal(expectMind(resolveRoute(config, { channel: "web" })).session, "web-session");
  });

  it("matches exact sender", () => {
    const config: RoutingConfig = {
      rules: [{ sender: "alice", session: "alice" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "main",
    );
  });

  it("matches glob pattern in channel", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    assert.equal(expectMind(resolveRoute(config, { channel: "discord:12345" })).session, "discord");
    assert.equal(expectMind(resolveRoute(config, { channel: "web" })).session, "main");
  });

  it("matches multiple criteria (AND)", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "web", sender: "alice", session: "alice-web" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice-web",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "main",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "cli", sender: "alice" })).session,
      "main",
    );
  });

  it("first matching rule wins", () => {
    const config: RoutingConfig = {
      rules: [
        { sender: "alice", session: "alice-special" },
        { channel: "web", session: "web-default" },
      ],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice-special",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "web-default",
    );
  });

  it("rule with no match criteria matches everything", () => {
    const config: RoutingConfig = {
      rules: [{ session: "catch-all" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "catch-all",
    );
    assert.equal(expectMind(resolveRoute(config, {})).session, "catch-all");
  });

  it("ignores unknown rule keys (no match)", () => {
    const config = {
      rules: [{ chanel: "web", session: "typo-rule" }],
      default: "main",
    } as unknown as RoutingConfig;
    assert.equal(
      expectMind(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "main",
    );
  });

  // --- Template expansion ---

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
  it("expands ${sender} template variable", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "discord:*", session: "discord-${sender}" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "discord:123", sender: "alice" })).session,
      "discord-alice",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "discord:123", sender: "bob" })).session,
      "discord-bob",
    );
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
  it("expands ${channel} template variable", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "discord:*", session: "chan-${channel}" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "discord:12345" })).session,
      "chan-discord:12345",
    );
  });

  it("handles missing sender in template expansion", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "web", session: "user-${sender}" }],
      default: "main",
    };
    assert.equal(expectMind(resolveRoute(config, { channel: "web" })).session, "user-unknown");
  });

  it("returns $new literally (server handles generation)", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "system:scheduler", session: "$new" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "system:scheduler", sender: "cleanup" })).session,
      "$new",
    );
  });

  // --- Scheduler patterns ---

  it("scheduler schedule id as sender", () => {
    const config: RoutingConfig = {
      rules: [
        { channel: "system:scheduler", sender: "daily-report", session: "daily-report" },
        { channel: "system:scheduler", sender: "cleanup", session: "$new" },
      ],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "system:scheduler", sender: "daily-report" }))
        .session,
      "daily-report",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "system:scheduler", sender: "cleanup" })).session,
      "$new",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "system:scheduler", sender: "other" })).session,
      "main",
    );
  });

  // --- Mixed destinations ---

  it("file destination rules work with match keys", () => {
    const config: RoutingConfig = {
      rules: [
        {
          channel: "discord:*",
          sender: "bot-*",
          destination: "file",
          path: "home/inbox/bots.md",
        },
        { channel: "discord:*", session: "discord" },
      ],
      default: "main",
    };
    const botRoute = resolveRoute(config, { channel: "discord:123", sender: "bot-webhook" });
    assert.equal(botRoute.destination, "file");
    assert.equal(botRoute.path, "home/inbox/bots.md");

    const humanRoute = expectMind(
      resolveRoute(config, { channel: "discord:123", sender: "alice" }),
    );
    assert.equal(humanRoute.session, "discord");
  });

  // --- Sanitization ---

  it("sanitizes path traversal in sender template", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ channel: "discord:*", session: "discord-${sender}" }],
      default: "main",
    };
    const r = expectMind(
      resolveRoute(config, { channel: "discord:123", sender: "../../etc/passwd" }),
    );
    assert.ok(!r.session.includes("/"), `session name should not contain /: ${r.session}`);
    assert.ok(!r.session.includes(".."), `session name should not contain ..: ${r.session}`);
  });

  it("sanitizes path traversal in channel template", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ sender: "alice", session: "chan-${channel}" }],
      default: "main",
    };
    const r = expectMind(resolveRoute(config, { channel: "../../home/SOUL", sender: "alice" }));
    assert.ok(!r.session.includes("/"), `session name should not contain /: ${r.session}`);
    assert.ok(!r.session.includes(".."), `session name should not contain ..: ${r.session}`);
  });

  it("sanitizes backslashes in session names", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ channel: "*", session: "s-${sender}" }],
      default: "main",
    };
    const r = expectMind(resolveRoute(config, { channel: "web", sender: "..\\..\\etc\\passwd" }));
    assert.ok(!r.session.includes("\\"), `session name should not contain \\: ${r.session}`);
    assert.ok(!r.session.includes(".."), `session name should not contain ..: ${r.session}`);
  });

  // --- isDM matching ---

  it("matches isDM: true", () => {
    const config: RoutingConfig = {
      rules: [{ isDM: true, session: "dm" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: true })).session,
      "dm",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: false })).session,
      "main",
    );
    assert.equal(expectMind(resolveRoute(config, { channel: "volute:abc" })).session, "main");
  });

  it("matches isDM: false", () => {
    const config: RoutingConfig = {
      rules: [{ isDM: false, session: "group" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: false })).session,
      "group",
    );
    // isDM undefined treated as false
    assert.equal(expectMind(resolveRoute(config, { channel: "volute:abc" })).session, "group");
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: true })).session,
      "main",
    );
  });

  // --- participants matching ---

  it("matches participants count", () => {
    const config: RoutingConfig = {
      rules: [{ participants: 2, session: "one-on-one" }],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", participantCount: 2 })).session,
      "one-on-one",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", participantCount: 5 })).session,
      "main",
    );
    assert.equal(expectMind(resolveRoute(config, { channel: "volute:abc" })).session, "main");
  });

  it("combines isDM with channel for routing", () => {
    const config: RoutingConfig = {
      rules: [
        { channel: "volute:*", isDM: true, session: "volute-dm" },
        { channel: "volute:*", session: "volute-group" },
      ],
      default: "main",
    };
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: true })).session,
      "volute-dm",
    );
    assert.equal(
      expectMind(resolveRoute(config, { channel: "volute:abc", isDM: false })).session,
      "volute-group",
    );
  });

  // --- matched field ---

  it("returns matched: true when a rule matches", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = resolveRoute(config, { channel: "discord:123" });
    assert.equal(r.matched, true);
  });

  it("returns matched: false when falling through to default", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = resolveRoute(config, { channel: "web" });
    assert.equal(r.matched, false);
  });

  it("returns matched: false when no rules exist", () => {
    const r = resolveRoute({}, { channel: "web" });
    assert.equal(r.matched, false);
  });

  it("returns matched: true for file destination rule", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:logs", destination: "file", path: "home/inbox/logs.md" }],
    };
    const r = resolveRoute(config, { channel: "discord:logs" });
    assert.equal(r.matched, true);
    assert.equal(r.destination, "file");
  });
});

describe("resolveSessionConfig", () => {
  it("returns defaults when no sessions configured", () => {
    const r = resolveSessionConfig({}, "main");
    assert.equal(r.autoReply, false);
    assert.equal(r.interrupt, true);
    assert.equal(r.batch, undefined);
    assert.equal(r.instructions, undefined);
  });

  it("matches exact session name", () => {
    const config: RoutingConfig = {
      sessions: { discord: { interrupt: false, autoReply: true } },
    };
    const r = resolveSessionConfig(config, "discord");
    assert.equal(r.interrupt, false);
    assert.equal(r.autoReply, true);
  });

  it("matches glob pattern", () => {
    const config: RoutingConfig = {
      sessions: { "volute:*": { autoReply: true } },
    };
    const r = resolveSessionConfig(config, "volute:conv-abc");
    assert.equal(r.autoReply, true);
  });

  it("first match wins", () => {
    const config: RoutingConfig = {
      sessions: {
        "discord:*": { interrupt: false },
        "*": { interrupt: true, autoReply: true },
      },
    };
    const r = resolveSessionConfig(config, "discord:general");
    assert.equal(r.interrupt, false);
    assert.equal(r.autoReply, false); // default, not from second pattern
  });

  it("normalizes batch number (minutes) to BatchConfig", () => {
    const config: RoutingConfig = {
      sessions: { discord: { batch: 15 } },
    };
    const r = resolveSessionConfig(config, "discord");
    assert.deepEqual(r.batch, { maxWait: 900 }); // 15 * 60
  });

  it("passes through BatchConfig object", () => {
    const config: RoutingConfig = {
      sessions: {
        discord: { batch: { debounce: 20, maxWait: 120, triggers: ["@bot"] } },
      },
    };
    const r = resolveSessionConfig(config, "discord");
    assert.deepEqual(r.batch, { debounce: 20, maxWait: 120, triggers: ["@bot"] });
  });

  it("autoReply is forced to false when batch is also configured", () => {
    const config: RoutingConfig = {
      sessions: { discord: { autoReply: true, batch: 5 } },
    };
    const r = resolveSessionConfig(config, "discord");
    assert.equal(r.autoReply, false);
    assert.ok(r.batch != null, "batch should still be set");
  });

  it("returns instructions when configured", () => {
    const config: RoutingConfig = {
      sessions: { discord: { instructions: "Brief responses only." } },
    };
    const r = resolveSessionConfig(config, "discord");
    assert.equal(r.instructions, "Brief responses only.");
  });

  it("returns defaults for unmatched session", () => {
    const config: RoutingConfig = {
      sessions: { discord: { autoReply: true } },
    };
    const r = resolveSessionConfig(config, "slack");
    assert.equal(r.autoReply, false);
    assert.equal(r.interrupt, true);
    assert.equal(r.batch, undefined);
  });
});
