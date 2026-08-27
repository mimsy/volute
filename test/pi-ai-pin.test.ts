import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// pi-ai ships breaking changes in patch releases: 0.80.8 turned the `/oauth`
// subpath into a type-only entry point (`export {}` at runtime), removing
// getOAuthApiKey/getOAuthProvider/getOAuthProviders. A caret range let a global
// `npm i -g volute` resolve to it and crash the daemon at import, while our
// lockfile kept CI on a working version. Global installs ignore our lockfile,
// so the declared range is the only thing protecting users here.
//
// That removal is still in force as of 0.84.3, and it now blocks a fix we want.
// The pin is stuck at 0.80.6 for a reason worth writing down, because the next
// person to run `npm outdated` will want to bump it:
//
//   - runtime `/oauth` exports vanish in 0.80.8 and have not returned;
//   - `claude-opus-5` first enters the builtin catalog in 0.82.1 (0.82.0 lacks it).
//
// There is no version with both. Until the OAuth surface is migrated, staying on
// 0.80.6 means `getBuiltinModels("anthropic")` has no `claude-opus-5` entry, so
// usage-pricing.ts prices every opus-5 turn at null and SpendBudget accumulates
// nothing for it. Bumping past 0.80.7 without that migration is worse: the named
// imports in ai-service.ts, web/api/system.ts and lib/oauth/xai.ts fail to link
// against `export {}` and the daemon dies at startup.
//
// 0.84.3 replaced the global OAuth registry (getOAuthProvider/registerOAuthProvider/
// pollOAuthDeviceCodeFlow) with per-provider `provider.auth.oauth` built via
// `lazyOAuth`, and ships its own xai flow — so the migration is a rewrite of
// Volute's OAuth layer, not a re-import, and likely retires lib/oauth/xai.ts.
describe("pi-ai dependency pin", () => {
  it("pins an exact version so installs cannot drift onto an untested release", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const range = pkg.dependencies["@earendil-works/pi-ai"];

    assert.match(
      range,
      /^\d+\.\d+\.\d+$/,
      `@earendil-works/pi-ai must be pinned exactly, got "${range}". ` +
        "Upstream removes runtime exports in patch releases; bump this pin only " +
        "after verifying the `/oauth` subpath still exports what we import.",
    );
  });

  it("resolves the installed pi-ai to the pinned version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");

    assert.equal(typeof getOAuthApiKey, "function");
    assert.match(pkg.dependencies["@earendil-works/pi-ai"], /^\d+\.\d+\.\d+$/);
  });
});
