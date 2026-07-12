import DOMPurify from "isomorphic-dompurify";

/**
 * Server-side twin of `@volute/ui`'s `sanitizeSvg`. Activity icons are stored in
 * the `activity` table's metadata and round-tripped to the host dashboard,
 * where they render as raw HTML. Sanitize before the value reaches the DB so a
 * malicious `metadata.icon` can never become stored XSS, keeping the allowlist
 * in sync with the render-time sanitizer (belt-and-braces).
 */
const ALLOWED_TAGS = ["svg", "path", "circle", "rect", "line", "polyline", "polygon", "g"];

const ALLOWED_ATTR = [
  "viewBox",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "width",
  "height",
  "points",
  "transform",
];

export function sanitizeSvgIcon(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["script", "foreignObject"],
    FORBID_ATTR: ["href", "xlink:href"],
  });
}
