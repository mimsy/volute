import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Marked } from "marked";

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
`;

export function parseFrontmatter(raw: string): { title?: string; style?: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { body: raw };

  const block = match[1];
  const body = raw.slice(match[0].length);

  const titleMatch = block.match(/^title:\s*(.+)$/m);
  const styleMatch = block.match(/^style:\s*(.+)$/m);

  return {
    title: titleMatch?.[1].trim(),
    style: styleMatch?.[1].trim(),
    body,
  };
}

export function resolveStylesheet(
  mdFilePath: string,
  pagesRoot: string,
  frontmatterStyle?: string,
): string | null {
  // Frontmatter override — path relative to pages root
  if (frontmatterStyle) {
    const abs = resolve(pagesRoot, frontmatterStyle);
    if (existsSync(abs)) return frontmatterStyle;
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

export function renderMarkdownPage(
  body: string,
  opts: { title?: string; stylesheetUrl?: string },
): string {
  const html = marked.parse(body) as string;
  const title = opts.title || "Untitled";
  const linkTag = opts.stylesheetUrl
    ? `\n    <link rel="stylesheet" href="${opts.stylesheetUrl}">`
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
