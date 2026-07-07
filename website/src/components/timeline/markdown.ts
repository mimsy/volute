// Vendored from packages/ui/src/markdown.ts
import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ breaks: true, gfm: true });

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}
