import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  addCustomModel,
  removeAiConfig,
  saveProviderConfig,
  setEnabledModels,
} from "../packages/daemon/src/lib/ai-service.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { activity, systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  findUnresolvedEnabledModels,
  reportUnresolvedEnabledModels,
  UNRESOLVED_MODELS_ALERT_KIND,
} from "../packages/daemon/src/lib/unresolved-models.js";

// pi-ai 1.x dropped gpt-5.5 from openai-codex; claude-opus-5 is in the anthropic catalog.
const GONE = "openai-codex:gpt-5.5";
const PRESENT = "anthropic:claude-opus-5";

async function clearAlertState(): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, getSpiritName()));
  await db.delete(activity).where(eq(activity.mind, getSpiritName()));
  rmSync(resolve(voluteSystemDir(), "unresolved-models.json"), { force: true });
  removeAiConfig();
}

async function spiritEvents() {
  const db = await getDb();
  return db.select().from(systemEvents).where(eq(systemEvents.mind, getSpiritName()));
}

describe("enabled models the catalog no longer carries", () => {
  beforeEach(clearAlertState);
  after(clearAlertState);

  it("finds an enabled id that resolves to neither the catalog nor a custom model", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-x");
    setEnabledModels([PRESENT, GONE, "anthropic:claude-future-x"]);
    assert.deepEqual(findUnresolvedEnabledModels(), [GONE]);
  });

  it("alerts the host once, naming the id and what clears it", async () => {
    setEnabledModels([PRESENT, GONE]);
    await reportUnresolvedEnabledModels();
    await reportUnresolvedEnabledModels();

    const events = await spiritEvents();
    assert.equal(events.length, 1, "one alert, not one per daemon start");
    const [event] = events;
    assert.equal(JSON.parse(event.meta ?? "{}").subtype, UNRESOLVED_MODELS_ALERT_KIND);
    assert.match(event.body, /openai-codex:gpt-5\.5/);
    assert.doesNotMatch(event.body, /claude-opus-5/);
    assert.match(event.body, /Settings → AI/);

    const db = await getDb();
    const rows = await db.select().from(activity).where(eq(activity.mind, getSpiritName()));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "mind_error");
  });

  it("says nothing when every enabled id resolves", async () => {
    setEnabledModels([PRESENT]);
    await reportUnresolvedEnabledModels();
    assert.deepEqual(await spiritEvents(), []);
  });

  it("forgets an id once it is gone from the list, so a later drop is reported again", async () => {
    setEnabledModels([GONE]);
    await reportUnresolvedEnabledModels();
    setEnabledModels([PRESENT]);
    await reportUnresolvedEnabledModels();
    setEnabledModels([GONE]);
    await reportUnresolvedEnabledModels();
    assert.equal((await spiritEvents()).length, 2);
  });
});
