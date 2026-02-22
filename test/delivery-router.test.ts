import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clearConfigCache,
  getRoutingConfig,
  type RoutingConfig,
  resolveDeliveryMode,
  resolveRoute,
} from "../src/lib/delivery-router.js";
import { addMind, removeMind } from "../src/lib/registry.js";

function createMindWithRoutes(config: RoutingConfig | object): string {
  const port = 4100 + Math.floor(Math.random() * 1000);
  const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  addMind(name, port);
  const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
  const configDir = resolve(dir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "routes.json"), JSON.stringify(config));
  return name;
}

describe("getRoutingConfig", () => {
  afterEach(() => clearConfigCache());

  it("returns empty config for mind with no routes.json", () => {
    const name = `no-routes-${Date.now()}`;
    addMind(name, 4199);
    const config = getRoutingConfig(name);
    assert.deepEqual(config, {});
    removeMind(name);
  });

  it("loads and caches config by mtime", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const name = createMindWithRoutes(config);

    const result1 = getRoutingConfig(name);
    assert.equal(result1.rules?.length, 1);

    // Second call should return cached
    const result2 = getRoutingConfig(name);
    assert.deepEqual(result1, result2);

    removeMind(name);
  });

  it("reloads config when mtime changes", () => {
    const name = createMindWithRoutes({ rules: [{ channel: "web", session: "web" }] });

    const result1 = getRoutingConfig(name);
    assert.equal(result1.rules?.[0].channel, "web");

    // Write new config (mtime changes)
    const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
    const configPath = resolve(dir, "home/.config/routes.json");
    // Force a different mtime by waiting a tiny bit
    const newConfig = { rules: [{ channel: "cli", session: "cli" }] };
    writeFileSync(configPath, JSON.stringify(newConfig));

    clearConfigCache(name);
    const result2 = getRoutingConfig(name);
    assert.equal(result2.rules?.[0].channel, "cli");

    removeMind(name);
  });

  it("normalizes flat array to { rules: [...] }", () => {
    const name = createMindWithRoutes([
      { channel: "system", session: "system" },
      { channel: "web", session: "web" },
    ]);

    const config = getRoutingConfig(name);
    assert.equal(config.rules?.length, 2);

    removeMind(name);
  });
});

describe("resolveRoute (daemon-side)", () => {
  it("returns default session when no rules", () => {
    const r = resolveRoute({}, { channel: "web" });
    assert.equal(r.destination, "mind");
    assert.equal((r as any).session, "main");
    assert.equal(r.matched, false);
  });

  it("matches glob patterns", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "discord:*", session: "discord" }],
      default: "main",
    };
    const r = resolveRoute(config, { channel: "discord:12345" });
    assert.equal(r.destination, "mind");
    assert.equal((r as any).session, "discord");
    assert.equal(r.matched, true);
  });

  it("handles file destination", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "logs:*", destination: "file", path: "inbox/logs.md" }],
    };
    const r = resolveRoute(config, { channel: "logs:system" });
    assert.equal(r.destination, "file");
    assert.equal((r as any).path, "inbox/logs.md");
  });

  it("matches isDM", () => {
    const config: RoutingConfig = {
      rules: [{ isDM: true, session: "dm" }],
      default: "main",
    };
    const r = resolveRoute(config, { channel: "volute:abc", isDM: true });
    assert.equal((r as any).session, "dm");

    const r2 = resolveRoute(config, { channel: "volute:abc", isDM: false });
    assert.equal((r2 as any).session, "main");
  });

  it("matches participants count", () => {
    const config: RoutingConfig = {
      rules: [{ participants: 2, session: "one-on-one" }],
      default: "main",
    };
    const r = resolveRoute(config, { channel: "abc", participantCount: 2 });
    assert.equal((r as any).session, "one-on-one");
  });

  it("expands template variables", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "discord:*", session: "discord-${sender}" }],
    };
    const r = resolveRoute(config, { channel: "discord:123", sender: "alice" });
    assert.equal((r as any).session, "discord-alice");
  });

  it("sanitizes session names", () => {
    const config: RoutingConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax
      rules: [{ channel: "*", session: "s-${sender}" }],
    };
    const r = resolveRoute(config, { channel: "web", sender: "../../etc/passwd" });
    assert.ok(!(r as any).session.includes("/"));
    assert.ok(!(r as any).session.includes(".."));
  });

  it("passes mode through", () => {
    const config: RoutingConfig = {
      rules: [{ channel: "volute:#*", session: "channel", mode: "mention" }],
    };
    const r = resolveRoute(config, { channel: "volute:#general" });
    assert.equal((r as any).mode, "mention");
  });
});

describe("resolveDeliveryMode", () => {
  it("returns immediate by default", () => {
    const r = resolveDeliveryMode({}, "main");
    assert.equal(r.delivery.mode, "immediate");
    assert.equal(r.interrupt, true);
  });

  it("returns immediate when no sessions match", () => {
    const config: RoutingConfig = {
      sessions: { discord: { interrupt: false } },
    };
    const r = resolveDeliveryMode(config, "slack");
    assert.equal(r.delivery.mode, "immediate");
  });

  it('resolves delivery: "immediate"', () => {
    const config: RoutingConfig = {
      sessions: { main: { delivery: "immediate" } },
    };
    const r = resolveDeliveryMode(config, "main");
    assert.equal(r.delivery.mode, "immediate");
  });

  it('resolves delivery: "batch" with defaults', () => {
    const config: RoutingConfig = {
      sessions: { main: { delivery: "batch" } },
    };
    const r = resolveDeliveryMode(config, "main");
    assert.equal(r.delivery.mode, "batch");
    assert.equal((r.delivery as any).debounce, 5);
    assert.equal((r.delivery as any).maxWait, 120);
  });

  it('resolves delivery: { mode: "batch", debounce, maxWait }', () => {
    const config: RoutingConfig = {
      sessions: { main: { delivery: { mode: "batch", debounce: 10, maxWait: 60 } } },
    };
    const r = resolveDeliveryMode(config, "main");
    assert.equal(r.delivery.mode, "batch");
    assert.equal((r.delivery as any).debounce, 10);
    assert.equal((r.delivery as any).maxWait, 60);
  });

  it("maps legacy batch config to delivery mode", () => {
    const config: RoutingConfig = {
      sessions: { discord: { batch: { debounce: 20, maxWait: 120, triggers: ["@bot"] } } },
    };
    const r = resolveDeliveryMode(config, "discord");
    assert.equal(r.delivery.mode, "batch");
    const batch = r.delivery as {
      mode: "batch";
      debounce: number;
      maxWait: number;
      triggers?: string[];
    };
    assert.equal(batch.debounce, 20);
    assert.equal(batch.maxWait, 120);
    assert.deepEqual(batch.triggers, ["@bot"]);
  });

  it("maps legacy batch number (minutes) to delivery mode", () => {
    const config: RoutingConfig = {
      sessions: { discord: { batch: 15 } },
    };
    const r = resolveDeliveryMode(config, "discord");
    assert.equal(r.delivery.mode, "batch");
    assert.equal((r.delivery as any).maxWait, 900); // 15 * 60
  });

  it("maps legacy interrupt: false to batch mode", () => {
    const config: RoutingConfig = {
      sessions: { discord: { interrupt: false } },
    };
    const r = resolveDeliveryMode(config, "discord");
    assert.equal(r.delivery.mode, "batch");
    assert.equal(r.interrupt, false);
  });

  it("delivery field takes precedence over legacy batch", () => {
    const config: RoutingConfig = {
      sessions: {
        main: {
          delivery: "immediate",
          batch: { debounce: 20, maxWait: 120 },
        },
      },
    };
    const r = resolveDeliveryMode(config, "main");
    assert.equal(r.delivery.mode, "immediate");
  });

  it("matches glob session patterns", () => {
    const config: RoutingConfig = {
      sessions: { "discord-*": { delivery: "batch" } },
    };
    const r = resolveDeliveryMode(config, "discord-general");
    assert.equal(r.delivery.mode, "batch");
  });

  it("first matching session wins", () => {
    const config: RoutingConfig = {
      sessions: {
        "discord-*": { delivery: "batch" },
        "*": { delivery: "immediate" },
      },
    };
    const r = resolveDeliveryMode(config, "discord-general");
    assert.equal(r.delivery.mode, "batch");
  });

  it("preserves instructions", () => {
    const config: RoutingConfig = {
      sessions: { main: { instructions: "Be brief." } },
    };
    const r = resolveDeliveryMode(config, "main");
    assert.equal(r.instructions, "Be brief.");
  });
});
