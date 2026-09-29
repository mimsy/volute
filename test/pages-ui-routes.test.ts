import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMONS_MIND } from "../packages/extensions/pages/src/social.js";
import { COMMONS, pageRoute, siteRoute } from "../packages/extensions/pages/ui/src/lib/routes.js";

describe("pages UI routes", () => {
  it("names the commons the way the server does", () => {
    assert.equal(COMMONS, COMMONS_MIND);
  });

  it("routes the commons under the Pages section, not as a mind", () => {
    assert.equal(siteRoute(COMMONS), "/pages/_commons");
    assert.equal(pageRoute(COMMONS, "index.html"), "/pages/_commons/index.html");
  });

  it("routes a mind's site under that mind", () => {
    assert.equal(siteRoute("mimsy"), "/minds/mimsy/pages");
    assert.equal(pageRoute("mimsy", "notes/a.md"), "/minds/mimsy/pages/notes/a.md");
  });
});
