import DOMPurify from "dompurify";

/**
 * Static allowlist for inline SVG icons. Icons are round-tripped through the
 * `activity` table's metadata and originate from extension code today, but the
 * moment any extension passes mind-derived data into `metadata.icon` this
 * becomes stored XSS in the operator's dashboard. Treat icons as untrusted at
 * render time and permit only a static SVG shape vocabulary — no `script`,
 * event handlers, `foreignObject`, or `href`.
 */
export const SVG_ICON_ALLOWED_TAGS = [
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "g",
];

export const SVG_ICON_ALLOWED_ATTR = [
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

/** Sanitize an untrusted inline SVG icon string down to a static shape vocabulary. */
export function sanitizeSvg(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SVG_ICON_ALLOWED_TAGS,
    ALLOWED_ATTR: SVG_ICON_ALLOWED_ATTR,
    FORBID_TAGS: ["script", "foreignObject"],
    FORBID_ATTR: ["href", "xlink:href"],
  });
}
