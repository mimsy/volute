import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type RoutingConfig,
  reportRoutesConfigProblems,
  resolveDeliveryMode,
  resolveRoute,
  routesConfigProblems,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  migrateThreadBatchToDelivery,
  repairThreadBatchConfig,
} from "../packages/daemon/src/lib/mind/event-routes.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

const templatesRoot = resolve(import.meta.dirname, "../templates/_base");

function shippedRoutes(rel: string, name: string): RoutingConfig {
  const raw = readFileSync(resolve(templatesRoot, rel), "utf-8");
  return JSON.parse(raw.replaceAll("{{name}}", name));
}

function mindDirWithRoutes(text: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "routes-batch-"));
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeFileSync(resolve(dir, "home/.config/routes.json"), text);
  return dir;
}

function readRoutes(dir: string): string {
  return readFileSync(resolve(dir, "home/.config/routes.json"), "utf-8");
}

async function noticesFor(mind: string, reason: string) {
  const db = await getDb();
  return db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.mind, mind),
        sql`json_extract(${systemEvents.meta}, '$.reason') = ${reason}`,
      ),
    )
    .all();
}

/** The routes.json every mind was created with before this fix, name substituted. */
const OLD_SHIPPED = `{
  "gateUnmatched": true,
  "rules": [
    { "channel": "mail:*", "thread": "mail" },
    { "channel": "*", "isDM": true, "thread": "\${channel}" },
    { "channel": "#*", "thread": "\${channel}" }
  ],
  "threads": {
    "#*": { "batch": { "debounce": 20, "maxWait": 120, "triggers": ["@mimsy"] } }
  },
  "default": "main"
}
`;

describe("shipped routes.json", () => {
  for (const rel of [".init/.config/routes.json", "home/.config/routes.json"]) {
    it(`${rel} batches channel threads, flushing early on a mention`, () => {
      const config = shippedRoutes(rel, "nova");
      const route = resolveRoute(config, { channel: "#garden" });
      assert.equal(route.session, "#garden");
      assert.deepEqual(resolveDeliveryMode(config, route.session, route.rule).delivery, {
        mode: "batch",
        debounce: 20,
        maxWait: 120,
        triggers: ["@nova"],
      });
      assert.deepEqual(routesConfigProblems(config), []);
    });
  }
});

describe("routesConfigProblems", () => {
  it("flags a batch key on a thread, which the router ignores", () => {
    const problems = routesConfigProblems(JSON.parse(OLD_SHIPPED));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /threads\["#\*"\] has unrecognized key\(s\) "batch"/);
  });

  it("flags unknown rule keys and non-mind destinations", () => {
    const problems = routesConfigProblems({
      rules: [
        { channel: "a", session: "x" },
        { channel: "logs:*", destination: "file", path: "log.md" },
        { channel: "b", destination: "mind", thread: "b" },
      ],
    } as unknown as RoutingConfig);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /rules\[0\].*"session".*never matches/);
    assert.match(problems[1], /rules\[1\].*"path".*never matches/);
    assert.match(problems[2], /rules\[1\].*destination "file".*never matches/);
  });
});

describe("reportRoutesConfigProblems", () => {
  it("tells the mind about a problem once, across daemon restarts", async () => {
    const mind = `rp-${process.pid}-a`;
    const bad = JSON.parse(OLD_SHIPPED);

    await reportRoutesConfigProblems(mind, bad);
    await reportRoutesConfigProblems(mind, bad);
    const first = await noticesFor(mind, "routes_config_problems");
    assert.equal(first.length, 1, "a reload of the same config doesn't repeat the notice");
    assert.match(first[0].body, /"batch"/);
    assert.equal(first[0].delivery, "next-turn");

    // A fresh module instance is what a restarted daemon has: no memory of the report.
    const restarted = await import(
      `../packages/daemon/src/lib/delivery/delivery-router.js?restart=${Date.now()}`
    );
    await restarted.reportRoutesConfigProblems(mind, bad);
    assert.equal((await noticesFor(mind, "routes_config_problems")).length, 1);

    // A new problem is reported on its own, without repeating the one already heard.
    await reportRoutesConfigProblems(mind, {
      ...bad,
      threads: { ...bad.threads, main: { colour: "blue" } },
    });
    const second = await noticesFor(mind, "routes_config_problems");
    assert.equal(second.length, 2);
    assert.match(second[1].body, /"colour"/);
    assert.doesNotMatch(second[1].body, /"batch"/);

    // Fixed, then broken again: the reintroduced problem is reported afresh.
    await reportRoutesConfigProblems(mind, {});
    await reportRoutesConfigProblems(mind, bad);
    assert.equal((await noticesFor(mind, "routes_config_problems")).length, 3);
  });
});

describe("migrateThreadBatchToDelivery", () => {
  it("renames the key in place and leaves every other byte alone", () => {
    const dir = mindDirWithRoutes(OLD_SHIPPED);
    const migrated = migrateThreadBatchToDelivery(dir);
    assert.deepEqual(migrated, [
      { pattern: "#*", batch: { debounce: 20, maxWait: 120, triggers: ["@mimsy"] } },
    ]);
    assert.equal(
      readRoutes(dir),
      OLD_SHIPPED.replace('{ "batch": { "debounce"', '{ "delivery": { "mode": "batch", "debounce"'),
    );
    const config = JSON.parse(readRoutes(dir));
    assert.deepEqual(routesConfigProblems(config), []);
    assert.equal(resolveDeliveryMode(config, "#garden").delivery.mode, "batch");
  });

  it("is idempotent", () => {
    const dir = mindDirWithRoutes(OLD_SHIPPED);
    migrateThreadBatchToDelivery(dir);
    const once = readRoutes(dir);
    assert.deepEqual(migrateThreadBatchToDelivery(dir), []);
    assert.equal(readRoutes(dir), once);
  });

  it("handles multi-line batch objects and keeps unrelated threads and settings", () => {
    const text = `{
  "rules": [{ "channel": "#*", "thread": "\${channel}" }],
  "threads": {
    "main": { "interrupt": true, "instructions": "a \\"batch\\": { note" },
    "volute:*": {
      "batch": {
        "maxWait": 600
      },
      "instructions": "be brief"
    }
  }
}
`;
    const dir = mindDirWithRoutes(text);
    assert.deepEqual(
      migrateThreadBatchToDelivery(dir).map((m) => m.pattern),
      ["volute:*"],
    );
    assert.equal(readRoutes(dir), text.replace('"batch": {\n', '"delivery": { "mode": "batch",\n'));
  });

  it("leaves a thread alone when it already has delivery, or batch isn't an object", () => {
    const text = `{"threads":{"a":{"delivery":"immediate","batch":{"maxWait":5}},"b":{"batch":30}}}`;
    const dir = mindDirWithRoutes(text);
    assert.deepEqual(migrateThreadBatchToDelivery(dir), []);
    assert.equal(readRoutes(dir), text);
  });

  it("falls back to re-serializing when the text rewrite can't be exact", () => {
    // A thread *named* "batch" defeats the text rewrite; the result must still be right.
    const text = `{"threads":{"batch":{"interrupt":true},"#*":{"batch":{"debounce":3}}}}`;
    const dir = mindDirWithRoutes(text);
    assert.deepEqual(
      migrateThreadBatchToDelivery(dir).map((m) => m.pattern),
      ["#*"],
    );
    assert.deepEqual(JSON.parse(readRoutes(dir)), {
      threads: { batch: { interrupt: true }, "#*": { delivery: { mode: "batch", debounce: 3 } } },
    });
  });

  it("never writes through a symlink planted at routes.json", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "routes-batch-"));
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const outside = resolve(mkdtempSync(resolve(tmpdir(), "routes-outside-")), "victim.json");
    writeFileSync(outside, OLD_SHIPPED);
    symlinkSync(outside, resolve(dir, "home/.config/routes.json"));
    assert.deepEqual(migrateThreadBatchToDelivery(dir), []);
    assert.equal(readFileSync(outside, "utf-8"), OLD_SHIPPED);
  });

  it("never writes through a hard link to a file elsewhere", () => {
    const outside = resolve(mkdtempSync(resolve(tmpdir(), "routes-outside-")), "victim.json");
    writeFileSync(outside, OLD_SHIPPED);
    const dir = mkdtempSync(resolve(tmpdir(), "routes-batch-"));
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    linkSync(outside, resolve(dir, "home/.config/routes.json"));
    assert.deepEqual(migrateThreadBatchToDelivery(dir), []);
    assert.equal(readFileSync(outside, "utf-8"), OLD_SHIPPED);
  });

  it("does nothing when there is no routes.json", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "routes-batch-"));
    assert.deepEqual(migrateThreadBatchToDelivery(dir), []);
  });
});

describe("repairThreadBatchConfig", () => {
  it("tells the mind its batching now takes effect, once", async () => {
    const mind = `rp-${process.pid}-b`;
    const dir = mindDirWithRoutes(OLD_SHIPPED);
    await repairThreadBatchConfig(dir, mind);
    await repairThreadBatchConfig(dir, mind);
    const notices = await noticesFor(mind, "thread_batch_repaired");
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /"#\*".*20s.*120s.*"@mimsy"/);
  });

  it("withdraws an unread problem notice the repair made untrue", async () => {
    const mind = `rp-${process.pid}-c`;
    const withExtra = OLD_SHIPPED.replace(
      '"threads": {',
      '"threads": {\n    "main": { "colour": "blue" },',
    );
    const dir = mindDirWithRoutes(withExtra);
    await reportRoutesConfigProblems(mind, JSON.parse(withExtra));
    const [stale] = await noticesFor(mind, "routes_config_problems");
    assert.equal(stale.delivered_at, null);

    await repairThreadBatchConfig(dir, mind);

    const [withdrawn] = await noticesFor(mind, "routes_config_problems");
    assert.notEqual(withdrawn.delivered_at, null, "the stale notice must not reach the mind");
    assert.equal(JSON.parse(withdrawn.meta ?? "{}").superseded, 1);
    assert.equal((await noticesFor(mind, "thread_batch_repaired")).length, 1);

    // What that notice said and is still true is reported again on the next read.
    await reportRoutesConfigProblems(mind, JSON.parse(readRoutes(dir)));
    const notices = await noticesFor(mind, "routes_config_problems");
    assert.equal(notices.length, 2);
    assert.match(notices[1].body, /"colour"/);
    assert.doesNotMatch(notices[1].body, /"batch"/);
  });
});
