import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { providerOAuth } from "../packages/daemon/src/lib/ai-service.js";
import { lookupRates } from "../packages/daemon/src/lib/daemon/usage-pricing.js";

// pi-ai ships breaking changes in patch releases: 0.80.8 turned the `/oauth`
// subpath into a type-only entry point (`export {}` at runtime), removing
// getOAuthApiKey/getOAuthProvider/getOAuthProviders. A caret range let a global
// `npm i -g volute` resolve to it and crash the daemon at import, while our
// lockfile kept CI on a working version. Global installs ignore our lockfile,
// so the declared range is the only thing protecting users here.
//
// We are past that break now: the pin is 0.84.3 and Volute uses the auth API that
// replaced the registry — per-provider `provider.auth.oauth` (login/refresh/toAuth)
// reached via `builtinProviders()`. Nothing imports `/oauth` at runtime any more,
// which is why the assertions below check the new surface.
//
// Why the pin had to move, for anyone tempted to roll it back: runtime `/oauth`
// died at 0.80.8 and `claude-opus-5` did not enter the builtin catalog until
// 0.82.1 (0.82.0 lacks it). No release has both, so there was no version that both
// kept the old OAuth imports working and priced opus-5. Staying on 0.80.6 meant
// every opus-5 turn priced to null and no spend cap could bind on it.
describe("pi-ai dependency pin", () => {
  it("pins an exact version so installs cannot drift onto an untested release", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const range = pkg.dependencies["@earendil-works/pi-ai"];

    assert.match(
      range,
      /^\d+\.\d+\.\d+$/,
      `@earendil-works/pi-ai must be pinned exactly, got "${range}". ` +
        "Upstream removes runtime exports in patch releases; bump this pin only " +
        "after verifying the auth surface still exports what we import.",
    );
  });

  it("pins pi-coding-agent to the same exact version as pi-ai", () => {
    // They share internal types; a split version is how you get a build that
    // typechecks against one copy and runs against another.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const piAi = pkg.dependencies["@earendil-works/pi-ai"];
    const agent = pkg.devDependencies["@earendil-works/pi-coding-agent"];
    assert.match(agent, /^\d+\.\d+\.\d+$/, "pi-coding-agent must be pinned exactly");
    assert.equal(agent, piAi, "pi-ai and pi-coding-agent must move together");
  });

  it("the pi template pins the same versions as the root", () => {
    // A mind's own install resolves the template's package.json, not our lockfile.
    const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const tpl = JSON.parse(
      readFileSync(new URL("../templates/pi/package.json", import.meta.url), "utf8"),
    );
    assert.equal(
      tpl.dependencies["@earendil-works/pi-ai"],
      root.dependencies["@earendil-works/pi-ai"],
    );
    assert.equal(
      tpl.dependencies["@earendil-works/pi-coding-agent"],
      root.devDependencies["@earendil-works/pi-coding-agent"],
    );
  });

  it("resolves the installed pi-ai to a build carrying the OAuth auth surface", () => {
    // The runtime half of the pin: anthropic is the provider whose subscription
    // OAuth the daemon depends on, so its absence means the installed build is not
    // the one this code was written against.
    const oauth = providerOAuth("anthropic");
    assert.ok(oauth, "anthropic should offer OAuth via provider.auth.oauth");
    assert.equal(typeof oauth.login, "function");
    assert.equal(typeof oauth.refresh, "function");
    assert.equal(typeof oauth.toAuth, "function");
  });
});

describe("pi-ai model catalog", () => {
  // The reason the pin moved at all. On 0.80.6 the catalog had no claude-opus-5,
  // so usage-pricing priced every opus-5 turn null and SpendBudget accumulated
  // nothing for it — a cap that could not bind on a model minds actually run.
  it("prices claude-opus-5, so opus-5 turns are not recorded unpriced", () => {
    const rates = lookupRates({ provider: "anthropic", id: "claude-opus-5" });
    assert.ok(rates, "claude-opus-5 must resolve to catalog rates");
    assert.ok(rates.input > 0, "input rate must be non-zero");
    assert.ok(rates.output > 0, "output rate must be non-zero");
  });

  it("carries claude-opus-5 in the anthropic catalog", () => {
    const ids = (getBuiltinModels("anthropic") as { id: string }[]).map((m) => m.id);
    assert.ok(ids.includes("claude-opus-5"), `claude-opus-5 missing from: ${ids.join(", ")}`);
  });
});
