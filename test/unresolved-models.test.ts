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
import { mindEnvPath, writeEnv } from "../packages/daemon/src/lib/config/env.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { composeMindEnv } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { activity, systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  findUnresolvedEnabledModels,
  MIND_MODEL_UNRESOLVED_ALERT_KIND,
  piModelResolves,
  refuseUnresolvedPiModel,
  reportUnresolvedEnabledModels,
  UNRESOLVED_MODELS_ALERT_KIND,
  UnresolvedMindModelError,
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

async function eventsFor(mind: string) {
  const db = await getDb();
  return db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
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

describe("the azure provider rename", () => {
  beforeEach(clearAlertState);
  after(clearAlertState);

  it("tells a host with azure-openai-responses ids to re-add credentials under azure", async () => {
    setEnabledModels(["azure-openai-responses:gpt-5.4"]);
    await reportUnresolvedEnabledModels();
    const [event] = await spiritEvents();
    assert.ok(event, "expected an alert");
    assert.match(event.body, /azure-openai-responses:gpt-5\.4/);
    assert.match(event.body, /renamed `azure`/);
    assert.match(event.body, /re-add the Azure credentials under `azure`/);
  });

  it("says nothing about azure when no id is under the old provider", async () => {
    setEnabledModels([GONE]);
    await reportUnresolvedEnabledModels();
    const [event] = await spiritEvents();
    assert.doesNotMatch(event.body, /azure/);
  });
});

describe("refusing a pi mind whose model resolves to nothing", () => {
  const MIND = "unresolved-model-mind";
  const clear = async () => {
    await clearAlertState();
    const db = await getDb();
    await db.delete(systemEvents).where(eq(systemEvents.mind, MIND));
    await db.delete(activity).where(eq(activity.mind, MIND));
  };
  beforeEach(clear);
  after(clear);

  it("resolves a catalog model or a registered custom one, and nothing else", () => {
    assert.equal(piModelResolves(PRESENT), true);
    assert.equal(piModelResolves(GONE), false);
    assert.equal(piModelResolves("anthropic:claude-future-x"), false);
    addCustomModel("anthropic", "claude-future-x");
    assert.equal(piModelResolves("anthropic:claude-future-x"), true);
    assert.equal(piModelResolves("no-colon"), false);
  });

  it("lets a mind on a resolvable model start, and says nothing", async () => {
    await refuseUnresolvedPiModel(MIND, PRESENT);
    assert.deepEqual(await eventsFor(MIND), []);
  });

  it("refuses the start, telling the host what to change", async () => {
    await assert.rejects(
      () => refuseUnresolvedPiModel(MIND, GONE),
      (err: Error) =>
        err instanceof UnresolvedMindModelError &&
        err.message.includes(`Not starting ${MIND}`) &&
        err.message.includes(GONE) &&
        /Settings → Model/.test(err.message),
    );
  });

  it("tells the mind itself, once per daemon run, plainly and in its own terms", async () => {
    const mind = `${MIND}-once`;
    try {
      await assert.rejects(() => refuseUnresolvedPiModel(mind, GONE), UnresolvedMindModelError);
      await assert.rejects(() => refuseUnresolvedPiModel(mind, GONE), UnresolvedMindModelError);
      const events = await eventsFor(mind);
      assert.equal(events.length, 1, "a retried start must not repeat the alert");
      const [event] = events;
      assert.equal(JSON.parse(event.meta ?? "{}").subtype, MIND_MODEL_UNRESOLVED_ALERT_KIND);
      assert.match(
        event.body,
        /^You were not started, because your model, `openai-codex:gpt-5\.5`/,
      );
      assert.match(event.body, /spend cap/);
      assert.match(event.body, /home\/\.config\/config\.json/);
      // The spirit hears it too, so it can reach the host.
      assert.equal((await spiritEvents()).length, 1);
    } finally {
      const db = await getDb();
      await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
      await db.delete(activity).where(eq(activity.mind, mind));
    }
  });
});

describe("the custom models a mind is handed", () => {
  const MIND = `custom-models-env-${process.pid}`;
  const compose = () =>
    composeMindEnv({
      name: MIND,
      baseName: MIND,
      dir: `/tmp/${MIND}`,
      port: 4198,
      mindToken: "tok",
      isolationMode: "none",
    });
  beforeEach(() => removeAiConfig());
  after(() => {
    removeAiConfig();
    writeEnv(mindEnvPath(MIND), {});
  });

  it("lists every registered custom model as provider:id", () => {
    assert.equal(compose().VOLUTE_CUSTOM_MODELS, "[]");
    addCustomModel("anthropic", "claude-future-x");
    assert.deepEqual(JSON.parse(compose().VOLUTE_CUSTOM_MODELS ?? ""), [
      "anthropic:claude-future-x",
    ]);
  });

  it("can't be widened by the mind's own env", () => {
    // A mind that planted its own list could run an unpriced model past the refusal.
    writeEnv(mindEnvPath(MIND), { VOLUTE_CUSTOM_MODELS: '["anthropic:anything"]' });
    assert.equal(compose().VOLUTE_CUSTOM_MODELS, "[]");
  });
});
