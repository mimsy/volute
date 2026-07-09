import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { sanitizeSvgIcon } from "../packages/daemon/src/lib/util/sanitize-svg.js";

// The browser-side @volute/ui sanitizer runs on `dompurify`, which needs a DOM.
// Provide one via jsdom before importing so the module initializes correctly.
type SanitizeSvg = (html: string) => string;
let sanitizeSvg: SanitizeSvg;

before(async () => {
  const { window } = new JSDOM("");
  (globalThis as unknown as { window: unknown }).window = window;
  (globalThis as unknown as { document: unknown }).document = window.document;
  ({ sanitizeSvg } = await import("../packages/ui/src/sanitize.js"));
});

// Both the render-time (@volute/ui) and write-time (daemon) sanitizers share the
// same allowlist, so run every case through both.
describe("svg icon sanitization", () => {
  function bothStrip(input: string, forbidden: string[]) {
    for (const [name, fn] of [
      ["sanitizeSvg", () => sanitizeSvg(input)],
      ["sanitizeSvgIcon", () => sanitizeSvgIcon(input)],
    ] as const) {
      const out = fn().toLowerCase();
      for (const bad of forbidden) {
        assert.ok(!out.includes(bad.toLowerCase()), `${name} should strip "${bad}" from: ${out}`);
      }
    }
  }

  it("passes a benign icon through, preserving shape tags and attributes", () => {
    const icon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 L2 22"/><circle cx="12" cy="12" r="4"/></svg>';
    for (const out of [sanitizeSvg(icon), sanitizeSvgIcon(icon)]) {
      assert.ok(out.includes("<svg"), "keeps <svg>");
      assert.ok(out.includes("<path"), "keeps <path>");
      assert.ok(out.includes("<circle"), "keeps <circle>");
      assert.ok(out.includes('viewBox="0 0 24 24"'), "keeps viewBox");
      assert.ok(out.includes('d="M12 2 L2 22"'), "keeps path data");
      assert.ok(out.includes('stroke="currentColor"'), "keeps stroke");
    }
  });

  it("strips inline event handlers", () => {
    bothStrip('<svg onload="alert(1)"><path d="M0 0" onclick="steal()"/></svg>', [
      "onload",
      "onclick",
      "alert",
    ]);
  });

  it("strips <script> content", () => {
    bothStrip('<svg><script>alert(document.cookie)</script><path d="M0 0"/></svg>', [
      "<script",
      "alert",
      "cookie",
    ]);
  });

  it("strips foreignObject (HTML-in-SVG injection vector)", () => {
    bothStrip('<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>', [
      "foreignobject",
      "onerror",
      "<img",
      "alert",
    ]);
  });

  it("strips href / xlink:href to block javascript: navigation", () => {
    bothStrip('<svg><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>', [
      "href",
      "javascript:",
    ]);
    bothStrip('<svg><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a></svg>', [
      "xlink:href",
      "javascript:",
    ]);
  });
});
