import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { migrateNamePlaceholders } from "../packages/daemon/src/lib/mind/migrate-name-placeholder.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

describe("migrateNamePlaceholders", () => {
  const name = `placeholder-test-${process.pid}`;

  afterEach(async () => {
    await removeMind(name);
  });

  function writeRoutes(content: unknown): string {
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
    mkdirSync(configDir, { recursive: true });
    const path = resolve(configDir, "routes.json");
    writeFileSync(path, JSON.stringify(content, null, 2));
    return path;
  }

  it("substitutes the mind's name into a leftover {{name}} batch trigger", async () => {
    await addMind(name, 4198);
    const path = writeRoutes({
      rules: [{ channel: "#*", thread: "garden" }],
      threads: {
        "#*": { batch: { debounce: 20, maxWait: 120, triggers: ["@{{name}}"] } },
      },
    });

    await migrateNamePlaceholders();

    const routes = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(routes.threads["#*"].batch.triggers, [`@${name}`]);
    // The rest of the mind-owned file is untouched.
    assert.deepEqual(routes.rules, [{ channel: "#*", thread: "garden" }]);
  });

  it("leaves an already-correct routes.json byte-identical", async () => {
    await addMind(name, 4198);
    const path = writeRoutes({
      threads: { "#*": { batch: { triggers: [`@${name}`] } } },
    });
    const before = readFileSync(path, "utf-8");

    await migrateNamePlaceholders();

    assert.equal(readFileSync(path, "utf-8"), before);
  });

  it("does not fail on a mind with no routes.json", async () => {
    await addMind(name, 4198);
    mkdirSync(resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config"), {
      recursive: true,
    });

    await migrateNamePlaceholders();
  });
});
