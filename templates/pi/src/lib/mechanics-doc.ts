import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** This template's mechanics doc, relative to the mind's home/. */
export const MECHANICS_DOC = "MINDS.md";

/**
 * Append the mechanics doc to the system prompt.
 *
 * pi-coding-agent only auto-loads a project context file named AGENTS.md or
 * CLAUDE.md (see @earendil-works/pi-coding-agent `core/resource-loader.js`), so
 * MINDS.md never reaches the model on its own — pi minds would run with no
 * mechanics doc at all. The claude and codex templates get theirs for free
 * because their runtimes read CLAUDE.md / AGENTS.md natively; pi has to be
 * handed its doc by hand.
 *
 * Kept in the system prompt (rather than injected as a context file) so it is
 * counted once, under `systemPrompt`, by the context breakdown.
 */
export function withMechanicsDoc(systemPrompt: string, homeDir: string): string {
  const path = resolve(homeDir, MECHANICS_DOC);
  let doc: string;
  try {
    doc = readFileSync(path, "utf-8").trim();
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    return systemPrompt;
  }
  return doc ? `${systemPrompt}\n\n---\n\n${doc}` : systemPrompt;
}
