import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clearConfigCache,
  getRoutingConfig,
  resolveRoute,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  migrateRoutesConfig,
  migrateThreadConfigs,
  migrateVoluteConfig,
} from "../packages/daemon/src/lib/mind/migrate-thread-config.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";

describe("migrateRoutesConfig", () => {
  it("renames rule session keys and the sessions map", () => {
    const config = {
      gateUnmatched: true,
      rules: [
        { channel: "*", isDM: true, session: "${channel}" },
        { channel: "#*", session: "${channel}" },
        { channel: "discord:logs", destination: "file", path: "notes/log.md" },
      ],
      sessions: { "#*": { batch: { debounce: 20 } } },
      default: "main",
    };
    assert.equal(migrateRoutesConfig(config), true);
    assert.deepEqual(config.rules[0], { channel: "*", isDM: true, thread: "${channel}" });
    assert.deepEqual(config.rules[1], { channel: "#*", thread: "${channel}" });
    // Non-session rules untouched
    assert.deepEqual(config.rules[2], {
      channel: "discord:logs",
      destination: "file",
      path: "notes/log.md",
    });
    assert.deepEqual((config as Record<string, unknown>).threads, {
      "#*": { batch: { debounce: 20 } },
    });
    assert.ok(!("sessions" in config), "legacy sessions map removed");
  });

  it("handles the flat-array rules form", () => {
    const config = [{ channel: "web", session: "web" }];
    assert.equal(migrateRoutesConfig(config), true);
    assert.deepEqual(config, [{ channel: "web", thread: "web" }]);
  });

  it("prefers an existing thread key but still drops the stale session key", () => {
    const config = { rules: [{ channel: "web", session: "old", thread: "new" }] };
    assert.equal(migrateRoutesConfig(config), true);
    assert.deepEqual(config.rules[0], { channel: "web", thread: "new" });
  });

  it("is a no-op on an already-migrated config", () => {
    const config = { rules: [{ channel: "#*", thread: "${channel}" }], threads: {} };
    assert.equal(migrateRoutesConfig(config), false);
  });
});

describe("migrateVoluteConfig", () => {
  it("renames schedule session keys", () => {
    const config = {
      schedules: [
        { id: "dream", cron: "0 3 * * *", message: "dream", enabled: true, session: "$new" },
        { id: "morning", cron: "0 9 * * *", message: "morning", enabled: true },
      ],
    };
    assert.equal(migrateVoluteConfig(config), true);
    assert.equal((config.schedules[0] as Record<string, unknown>).thread, "$new");
    assert.ok(!("session" in config.schedules[0]));
    assert.ok(!("thread" in config.schedules[1]), "untargeted schedule untouched");
  });

  it("is a no-op without schedules or session keys", () => {
    assert.equal(migrateVoluteConfig({}), false);
    assert.equal(migrateVoluteConfig({ schedules: [{ id: "x", enabled: true }] }), false);
  });
});

describe("migrateThreadConfigs (on-disk)", () => {
  const name = `migrate-test-${process.pid}`;

  afterEach(async () => {
    await removeMind(name);
    clearConfigCache();
  });

  it("rewrites a legacy mind's routes.json and volute.json once", async () => {
    await addMind(name, 4197);
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
    mkdirSync(configDir, { recursive: true });
    const routesPath = resolve(configDir, "routes.json");
    const volutePath = resolve(configDir, "volute.json");
    writeFileSync(
      routesPath,
      JSON.stringify({
        gateUnmatched: true,
        rules: [{ channel: "*", session: "${channel}" }],
        sessions: { "#*": { delivery: "batch" } },
        default: "main",
      }),
    );
    writeFileSync(
      volutePath,
      JSON.stringify({
        schedules: [
          { id: "dream", cron: "0 3 * * *", message: "m", enabled: true, session: "$new" },
        ],
      }),
    );

    await migrateThreadConfigs();

    const routes = JSON.parse(readFileSync(routesPath, "utf-8"));
    assert.deepEqual(routes.rules, [{ channel: "*", thread: "${channel}" }]);
    assert.deepEqual(routes.threads, { "#*": { delivery: "batch" } });
    assert.ok(!("sessions" in routes));
    const volute = JSON.parse(readFileSync(volutePath, "utf-8"));
    assert.equal(volute.schedules[0].thread, "$new");
    assert.ok(!("session" in volute.schedules[0]));

    // The migrated rule actually routes again (the pre-migration form would
    // have been rejected as an unknown-key rule and gated everything).
    clearConfigCache();
    const route = resolveRoute(getRoutingConfig(name), { channel: "@alice" });
    assert.deepEqual(route, {
      destination: "mind",
      session: "@alice",
      matched: true,
      mode: undefined,
      rule: { channel: "*", thread: "${channel}" },
    });

    // Idempotent: a second run leaves the files byte-identical.
    const routesBefore = readFileSync(routesPath, "utf-8");
    const voluteBefore = readFileSync(volutePath, "utf-8");
    await migrateThreadConfigs();
    assert.equal(readFileSync(routesPath, "utf-8"), routesBefore);
    assert.equal(readFileSync(volutePath, "utf-8"), voluteBefore);
  });
});

describe("unknown rule keys", () => {
  const name = `unknown-key-${process.pid}`;

  afterEach(async () => {
    await removeMind(name);
    clearConfigCache();
  });

  it("logs a warning at config load and the rule never matches", async () => {
    await addMind(name, 4196);
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, "routes.json"),
      JSON.stringify({ rules: [{ channel: "web", sesion: "typo" }], default: "fallback" }),
    );

    const lines: string[] = [];
    log.setOutput((line) => lines.push(line));
    try {
      clearConfigCache();
      const config = getRoutingConfig(name);
      const route = resolveRoute(config, { channel: "web" });
      // The rule with the unknown key is skipped entirely — fallback applies.
      assert.equal(route.destination, "mind");
      assert.equal((route as { session: string }).session, "fallback");
      assert.equal((route as { matched: boolean }).matched, false);

      const warns = lines.map((l) => JSON.parse(l)).filter((e) => e.level === "warn");
      assert.equal(warns.length, 1, "exactly one warning per config load");
      assert.match(warns[0].msg, /unrecognized key/);
      assert.match(warns[0].msg, /"sesion"/);

      // Cached loads do not re-warn.
      getRoutingConfig(name);
      const warnsAfter = lines.map((l) => JSON.parse(l)).filter((e) => e.level === "warn");
      assert.equal(warnsAfter.length, 1);
    } finally {
      log.setOutput((line) => process.stderr.write(`${line}\n`));
    }
  });
});
