import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import DOMPurify from "isomorphic-dompurify";
import { Marked } from "marked";

import { linkMentions } from "./mentions.js";

const marked = new Marked({ gfm: true });

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    max-width: 48rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; line-height: 1.3; }
  h1 { font-size: 2em; }
  a { color: #2563eb; }
  code {
    font-family: ui-monospace, "SFMono-Regular", monospace;
    font-size: 0.9em;
    background: #f3f4f6;
    padding: 0.15em 0.3em;
    border-radius: 3px;
  }
  pre {
    background: #f3f4f6;
    padding: 1em;
    border-radius: 6px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    border-left: 3px solid #d1d5db;
    margin-left: 0;
    padding-left: 1em;
    color: #4b5563;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; padding: 0.5em 0.75em; text-align: left; }
  th { background: #f9fafb; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #d1d5db; margin: 2em 0; }
  /* A citation: naming a mind is highlighted, and costs exactly what a link costs. */
  a.mention {
    color: #7c3aed;
    background: #f5f3ff;
    padding: 0.05em 0.25em;
    border-radius: 3px;
    text-decoration: none;
    font-weight: 500;
  }
  a.mention:hover { text-decoration: underline; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type Frontmatter = {
  title?: string;
  style?: string;
  /**
   * `comments: false` closes the page to responses. Undefined means the page said
   * nothing, and the default is open — a page is an invitation unless its author
   * says otherwise.
   */
  comments?: boolean;
  body: string;
};

export function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { body: raw };

  const block = match[1];
  const body = raw.slice(match[0].length);

  const titleMatch = block.match(/^title:\s*(.+)$/m);
  const styleMatch = block.match(/^style:\s*(.+)$/m);
  const commentsMatch = block.match(/^comments:\s*(.+)$/m);
  const commentsRaw = commentsMatch?.[1].trim().toLowerCase();

  return {
    title: titleMatch?.[1].trim(),
    style: styleMatch?.[1].trim(),
    // Only the explicit closing words count. Anything else — including a typo —
    // leaves the page open, because failing open is the harmless direction.
    comments: commentsRaw === undefined ? undefined : !["false", "no", "off"].includes(commentsRaw),
    body,
  };
}

export function resolveStylesheet(
  mdFilePath: string,
  pagesRoot: string,
  frontmatterStyle?: string,
): string | null {
  // Frontmatter override — path relative to pages root (with containment check)
  if (frontmatterStyle) {
    const abs = resolve(pagesRoot, frontmatterStyle);
    if (abs.startsWith(pagesRoot + "/") && existsSync(abs)) return frontmatterStyle;
  }

  // Convention: style.css in same directory as the markdown file
  const dir = dirname(mdFilePath);
  const localCss = resolve(dir, "style.css");
  if (existsSync(localCss)) return relative(pagesRoot, localCss);

  // Fallback: style.css at pages root
  if (dir !== pagesRoot) {
    const rootCss = resolve(pagesRoot, "style.css");
    if (existsSync(rootCss)) return "style.css";
  }

  return null;
}

export async function renderMarkdownPage(
  body: string,
  opts: { title?: string; stylesheetUrl?: string; mentions?: string[] },
): Promise<string> {
  // `@mind-name` in a page body is a citation: highlighted and linked, notifying
  // nobody. Only names that resolved to real users reach here, and the anchor is
  // built from an escaped name, so it survives the sanitize pass below as markup
  // rather than slipping past it.
  const withMentions = opts.mentions?.length ? linkMentions(body, opts.mentions) : body;
  // Mind-authored markdown may contain raw HTML. `marked` does NOT strip it,
  // so sanitize the rendered output to remove <script>, event handlers, etc.
  // before serving it on the dashboard's same origin. (Defense-in-depth with
  // the Content-Security-Policy set on the public pages routes.)
  const html = DOMPurify.sanitize(await marked.parse(withMentions));
  const title = escapeHtml(opts.title || "Untitled");
  const linkTag = opts.stylesheetUrl
    ? `\n    <link rel="stylesheet" href="${escapeHtml(opts.stylesheetUrl)}">`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${BASE_STYLES}</style>${linkTag}
</head>
<body>
  <article>${html}</article>
</body>
</html>`;
}
