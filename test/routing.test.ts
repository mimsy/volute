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
} from "../templates/_base/src/lib/routing.js";

/** Asserts route is agent-destined and returns the narrowed type. */
function expectAgent(route: ResolvedRoute) {
  assert.equal(route.destination, "agent");
  return route as Extract<ResolvedRoute, { destination: "agent" }>;
}

describe("loadRoutingConfig", () => {
  it("returns empty config for missing file", () => {
    const config = loadRoutingConfig("/nonexistent/sessions.json");
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
    const config = loadRoutingConfig(path);
    assert.equal(config.rules?.length, 1);
    assert.equal(config.default, "main");
  });
});

describe("resolveRoute", () => {
  // --- Basic routing ---

  it("returns agent destination with default session when no config", () => {
    const r = expectAgent(resolveRoute({}, { channel: "web" }));
    assert.equal(r.session, "main");
    assert.equal(r.interrupt, true);
    assert.equal(r.batch, undefined);
  });

  it("returns 'main' when config has no rules or default", () => {
    const r = expectAgent(resolveRoute({}, { channel: "web" }));
    assert.equal(r.session, "main");
  });

  it("returns agent destination for rules without destination field", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "discord:123" }));
    assert.equal(r.session, "discord");
    assert.equal(r.interrupt, true);
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
    const r = expectAgent(resolveRoute(config, { channel: "web" }));
    assert.equal(r.session, "fallback");
    assert.equal(r.interrupt, true);
  });

  // --- Match criteria ---

  it("matches exact channel", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "web", session: "web-session" }],
      default: "main",
    };
    assert.equal(expectAgent(resolveRoute(config, { channel: "web" })).session, "web-session");
  });

  it("matches exact sender", () => {
    const config: RoutingConfig = {
      rules: [{ sender: "alice", session: "alice" }],
      default: "main",
    };
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "main",
    );
  });

  it("matches glob pattern in channel", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "discord:12345" })).session,
      "discord",
    );
    assert.equal(expectAgent(resolveRoute(config, { channel: "web" })).session, "main");
  });

  it("matches multiple criteria (AND)", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "web", sender: "alice", session: "alice-web" }],
      default: "main",
    };
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice-web",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "main",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "cli", sender: "alice" })).session,
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
      expectAgent(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "alice-special",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "bob" })).session,
      "web-default",
    );
  });

  it("rule with no match criteria matches everything", () => {
    const config: RoutingConfig = {
      rules: [{ session: "catch-all" }],
      default: "main",
    };
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "alice" })).session,
      "catch-all",
    );
    assert.equal(expectAgent(resolveRoute(config, {})).session, "catch-all");
  });

  it("ignores unknown rule keys (no match)", () => {
    const config = {
      rules: [{ chanel: "web", session: "typo-rule" }],
      default: "main",
    } as unknown as RoutingConfig;
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "web", sender: "alice" })).session,
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
      expectAgent(resolveRoute(config, { channel: "discord:123", sender: "alice" })).session,
      "discord-alice",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "discord:123", sender: "bob" })).session,
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
      expectAgent(resolveRoute(config, { channel: "discord:12345" })).session,
      "chan-discord:12345",
    );
  });

  it("handles missing sender in template expansion", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "web", session: "user-${sender}" }],
      default: "main",
    };
    assert.equal(expectAgent(resolveRoute(config, { channel: "web" })).session, "user-unknown");
  });

  it("returns $new literally (server handles generation)", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "system:scheduler", session: "$new" }],
      default: "main",
    };
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "system:scheduler", sender: "cleanup" })).session,
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
      expectAgent(resolveRoute(config, { channel: "system:scheduler", sender: "daily-report" }))
        .session,
      "daily-report",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "system:scheduler", sender: "cleanup" })).session,
      "$new",
    );
    assert.equal(
      expectAgent(resolveRoute(config, { channel: "system:scheduler", sender: "other" })).session,
      "main",
    );
  });

  // --- Interrupt ---

  it("respects explicit interrupt setting", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "system:*", session: "main", interrupt: false }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "system:scheduler" }));
    assert.equal(r.interrupt, false);
  });

  // --- Batch ---

  it("includes batch from matching rule", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord-feed", batch: 15 }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "discord:123" }));
    assert.equal(r.batch, 15);
    assert.equal(r.session, "discord-feed");
  });

  it("returns undefined batch for matching rule without batch", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "discord:123" }));
    assert.equal(r.batch, undefined);
  });

  it("returns no batch when no rules match", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord-feed", batch: 15 }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "web" }));
    assert.equal(r.batch, undefined);
  });

  it("first matching rule wins for batch", () => {
    const config: RoutingConfig = {
      rules: [
        { channel: "discord:*", session: "discord-fast", batch: 5 },
        { channel: "discord:*", session: "discord-slow", batch: 30 },
      ],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "discord:123" }));
    assert.equal(r.batch, 5);
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

    const humanRoute = expectAgent(
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
    const r = expectAgent(
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
    const r = expectAgent(resolveRoute(config, { channel: "../../home/SOUL", sender: "alice" }));
    assert.ok(!r.session.includes("/"), `session name should not contain /: ${r.session}`);
    assert.ok(!r.session.includes(".."), `session name should not contain ..: ${r.session}`);
  });

  it("sanitizes backslashes in session names", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal config syntax
      rules: [{ channel: "*", session: "s-${sender}" }],
      default: "main",
    };
    const r = expectAgent(resolveRoute(config, { channel: "web", sender: "..\\..\\etc\\passwd" }));
    assert.ok(!r.session.includes("\\"), `session name should not contain \\: ${r.session}`);
    assert.ok(!r.session.includes(".."), `session name should not contain ..: ${r.session}`);
  });
});
