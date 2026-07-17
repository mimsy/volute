import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { enrichActivityMetadata } from "../packages/daemon/src/lib/extensions.js";
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

// The extension publishActivity enrichment is the write-time layer that keeps a
// malicious icon out of the DB. Exercise it directly so a future refactor that drops
// the sanitize step fails a test rather than silently disabling defense-in-depth.
describe("extension activity metadata enrichment", () => {
  it("sanitizes an event-supplied malicious icon before persisting", () => {
    const out = enrichActivityMetadata(
      { icon: undefined, color: undefined },
      { icon: '<svg onload="alert(1)"><script>steal()</script><path d="M0 0"/></svg>' },
    );
    const icon = String(out.icon).toLowerCase();
    assert.ok(!icon.includes("onload"), "strips inline handler");
    assert.ok(!icon.includes("<script"), "strips script tag");
    assert.ok(!icon.includes("alert"), "strips script body");
    assert.ok(!icon.includes("steal"), "strips script body");
    assert.ok(icon.includes("<path"), "keeps benign shape");
  });

  it("sanitizes a manifest-supplied fallback icon", () => {
    const out = enrichActivityMetadata(
      { icon: '<svg onload="evil()"><path d="M0 0"/></svg>', color: "purple" },
      undefined,
    );
    const icon = String(out.icon).toLowerCase();
    assert.ok(!icon.includes("onload"), "strips inline handler from manifest icon");
    assert.ok(!icon.includes("evil"), "strips handler body");
    assert.equal(out.color, "purple", "keeps color branding");
  });
});

// #729: App.svelte's extension tab icons (`sec.icon` for mind-section tabs,
// `ext.icon` for system-section tabs) are rendered via `{@html ...}` without
// going through `sanitizeSvg`, unlike every other render-time icon site (#398).
// Guard against both a functional regression (icon HTML not neutralized) and a
// source-level regression (someone reverting to a bare `{@html ext.icon}`).
describe("App.svelte extension tab icons (#729)", () => {
  it("neutralizes a hostile extension-supplied icon exactly as App.svelte renders it (sanitizeSvg(ext.icon ?? fallback))", () => {
    // Mirrors App.svelte: {@html sanitizeSvg(ext.icon ?? '<svg ...>')} — an
    // extension manifest can set `icon` to arbitrary HTML.
    const hostileExtIcon = '<svg onload="alert(1)"><script>steal()</script><path d="M0 0"/></svg>';
    const rendered = sanitizeSvg(hostileExtIcon).toLowerCase();
    assert.ok(!rendered.includes("onload"), "strips inline handler");
    assert.ok(!rendered.includes("<script"), "strips script tag");
    assert.ok(!rendered.includes("steal"), "strips script body");
  });

  it("leaves the trusted fallback SVG intact when ext.icon is unset", () => {
    // Mirrors App.svelte's fallback branch — sanitizeSvg must not mangle the
    // hardcoded default icon shown when an extension doesn't supply one.
    const fallback =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/></svg>';
    const rendered = sanitizeSvg(undefined ?? fallback);
    assert.ok(rendered.includes("<svg"), "keeps <svg>");
    assert.ok(rendered.includes('viewBox="0 0 16 16"'), "keeps viewBox");
    assert.ok(rendered.includes("<path"), "keeps <path>");
  });

  it("wraps both extension icon {@html} sites in App.svelte with sanitizeSvg", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../packages/web/src/ui/App.svelte"),
      "utf-8",
    );
    assert.match(
      source,
      /\{#if sec\.icon\}.*\{@html sanitizeSvg\(sec\.icon\)\}/,
      "mind-section tab icon (sec.icon) must be wrapped in sanitizeSvg",
    );
    assert.match(
      source,
      /\{@html sanitizeSvg\(ext\.icon \?\?/,
      "system-section tab icon (ext.icon) must be wrapped in sanitizeSvg",
    );
  });
});
