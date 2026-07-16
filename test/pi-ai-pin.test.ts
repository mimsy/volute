import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// pi-ai ships breaking changes in patch releases: 0.80.8 turned the `/oauth`
// subpath into a type-only entry point (`export {}` at runtime), removing
// getOAuthApiKey/getOAuthProvider/getOAuthProviders. A caret range let a global
// `npm i -g volute` resolve to it and crash the daemon at import, while our
// lockfile kept CI on a working version. Global installs ignore our lockfile,
// so the declared range is the only thing protecting users here.
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
