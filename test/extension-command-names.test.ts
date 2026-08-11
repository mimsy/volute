import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import intentions from "@volute/intentions";
import pages from "@volute/pages";

/**
 * An extension's CLI noun is its manifest `id` — `volute <id> <subcommand>` — derived
 * dynamically at dispatch time (`src/cli.ts` looks the noun up in the map returned by
 * `/api/v1/extensions/commands`, which is keyed by `manifest.id`). Nothing forces the
 * extension's own prose, skills, usage strings, or generated cron scripts to agree with
 * that id, so they can drift from the only name that actually works.
 *
 * They did. The intentions extension shipped documenting `volute intention ...`
 * (singular) in all 15 places it named the command — skills, CLI usage/error strings,
 * and the spirit's auto-provisioned `review-due` cron script — while the registered noun
 * is `volute intentions`. Every documented invocation failed with `Unknown command:
 * intention`. A mind that loaded the skill ran the documented command three times before
 * finding the real name via `--help`; the cron script had nobody to self-correct and
 * would simply have failed every day.
 *
 * This test re-derives the truth from the manifests and holds the docs to it. For every
 * `volute <noun> <subcommand>` in an extension's source, skills, and mindDoc, it requires:
 *   - the noun to be a real CLI noun (a core command, or some extension's id), and
 *   - if the noun names an extension, the subcommand to be one that extension registers.
 *
 * Mistyping the noun, or documenting a subcommand that was renamed or removed, fails here
 * rather than in front of a mind.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Core CLI nouns, read from the `case` labels of the dispatch switch in `src/cli.ts`.
 *
 * Parsed rather than imported: `cli.ts` is an entry point that dispatches off
 * `process.argv` and calls `process.exit` at import time, so a test cannot import it,
 * and exporting the list would mean extracting a new module just for this. There is
 * exactly one `switch (command)` in the file, so anchoring to it is unambiguous.
 *
 * A hand-maintained copy would defeat the point: this test exists to catch documentation
 * drifting from the dispatcher, and it shouldn't itself be a mirror that can drift.
 * Adding a core noun without updating a hardcoded set fails loudly, but *removing* one
 * would pass silently.
 */
function readCoreNouns(): Set<string> {
  const source = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
  const switchAt = source.indexOf("switch (command) {");
  if (switchAt === -1) return new Set();
  // Case labels only occur inside that switch; `case undefined:` is unquoted and so
  // is skipped, as are the `--help`/`-h` labels, which are flags rather than nouns.
  const labels = source.slice(switchAt).matchAll(/^\s*case "([^"]+)":/gm);
  return new Set([...labels].map((m) => m[1]).filter((label) => !label.startsWith("-")));
}

const CORE_NOUNS = readCoreNouns();

const EXTENSIONS = [intentions, pages];

/**
 * Placeholder nouns that stand for "any command" in prose rather than naming one, e.g.
 * "run `volute <cmd> --help`". Bracketed/angled/uppercase tokens are filtered separately;
 * these are the bare-word placeholders in use.
 */
const PLACEHOLDER_NOUNS = new Set(["cmd", "command", "noun", "subcommand"]);

/**
 * `volute <noun> <subcommand>`, where both tokens are bare lowercase words. Tokens
 * carrying placeholder syntax (`<x>`, `[x]`, `{{x}}`, `$VAR`) don't match, so prose like
 * "volute <cmd> --help" is skipped rather than reported.
 */
const INVOCATION = /\bvolute\s+([a-z][a-z-]*)\s+([a-z][a-z-]*)/g;

/**
 * A line carrying this marker is intentionally recording a command string that does NOT
 * work — the legacy-script list `spirit-schedule.ts` repairs against is the reason this
 * exists. Those lines name a command to fix, not one to run. Keep the exemption on the
 * single line that needs it, so it stays visible in review rather than widening the
 * scanner's blind spot.
 */
const EXEMPT_MARKER = "cli-noun-exempt";

const SCANNED_EXTENSIONS = new Set([".ts", ".js", ".md", ".json", ".svelte", ".sh"]);

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (SCANNED_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

type Invocation = { noun: string; subcommand: string; source: string };

function invocationsIn(text: string, source: string): Invocation[] {
  const found: Invocation[] = [];
  // Line-by-line so an exemption applies only to the line that carries it.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(EXEMPT_MARKER)) continue;
    for (const m of line.matchAll(INVOCATION)) {
      const [, noun, subcommand] = m;
      if (PLACEHOLDER_NOUNS.has(noun)) continue;
      found.push({ noun, subcommand, source: `${source}:${i + 1}` });
    }
  }
  return found;
}

describe("extension CLI command names", () => {
  const extensionIds = new Set(EXTENSIONS.map((e) => e.id));
  const commandsById = new Map(
    EXTENSIONS.map((e) => [e.id, new Set(Object.keys(e.commands ?? {}))]),
  );

  // Every documented invocation across all built-in extensions, gathered once.
  const invocations: Invocation[] = [];
  const filesPerExtension = new Map<string, number>();
  for (const ext of EXTENSIONS) {
    // Assumes the on-disk directory is named for the manifest id — true for every
    // built-in. If that ever stops holding, the file count below catches it rather
    // than the extension silently going unscanned.
    const dir = join(ROOT, "packages", "extensions", ext.id);
    const files = walk(dir);
    filesPerExtension.set(ext.id, files.length);
    for (const file of files) {
      invocations.push(...invocationsIn(readFileSync(file, "utf8"), relative(ROOT, file)));
    }
    if (ext.mindDoc) {
      invocations.push(...invocationsIn(ext.mindDoc, `${ext.id} manifest mindDoc`));
    }
  }

  it("reads the core CLI nouns out of the dispatch switch", () => {
    // If the parse breaks, CORE_NOUNS empties and every core-noun usage below starts
    // reporting as unknown — loud, but confusing. Fail here with the real reason.
    assert.ok(
      CORE_NOUNS.size > 10,
      `parsed ${CORE_NOUNS.size} core nouns from src/cli.ts — the dispatch switch has ` +
        "probably been restructured, so this test is no longer reading the real noun list",
    );
    // Spot-check a couple that have no reason to move, to catch a regex that matches
    // the right *number* of wrong things.
    for (const noun of ["mind", "chat", "clock"]) {
      assert.ok(CORE_NOUNS.has(noun), `expected "${noun}" among the parsed core nouns`);
    }
    assert.equal(CORE_NOUNS.has("--help"), false, "flags are not nouns");
  });

  it("actually scans every built-in extension", () => {
    // A scanner that quietly reads nothing passes every other assertion in this file.
    const unscanned = [...filesPerExtension].filter(([, count]) => count === 0).map(([id]) => id);
    assert.deepEqual(
      unscanned,
      [],
      "these extensions produced zero scanned files — the directory is probably not named " +
        "for the manifest id, so their docs are going unchecked",
    );
    assert.ok(
      invocations.length > 10,
      `expected a meaningful number of documented invocations, got ${invocations.length}`,
    );
  });

  it("documents only nouns the CLI actually dispatches", () => {
    const bad = invocations.filter((i) => !CORE_NOUNS.has(i.noun) && !extensionIds.has(i.noun));
    assert.deepEqual(
      bad.map((i) => `${i.source}: "volute ${i.noun} ${i.subcommand}"`),
      [],
      "these name a CLI noun that does not exist — an extension's noun is its manifest id " +
        `(one of: ${[...extensionIds].sort().join(", ")}), not a singular/plural variant of it`,
    );
  });

  it("documents only subcommands the naming extension registers", () => {
    const bad = invocations.filter((i) => {
      const commands = commandsById.get(i.noun);
      return commands !== undefined && !commands.has(i.subcommand);
    });
    assert.deepEqual(
      bad.map((i) => {
        const known = [...(commandsById.get(i.noun) ?? [])].sort().join(", ");
        return `${i.source}: "volute ${i.noun} ${i.subcommand}" (registered: ${known})`;
      }),
      [],
      "these document a subcommand the extension does not register",
    );
  });

  it("registers `intentions` as the noun its skills and cron script use", () => {
    // The specific regression: the spirit's auto-provisioned review script and the
    // mind-facing skill must name the noun the manifest actually registers.
    assert.ok(intentions.commands?.["review-due"], "intentions must register review-due");
    const schedule = readFileSync(
      join(ROOT, "packages/extensions/intentions/src/spirit-schedule.ts"),
      "utf8",
    );
    assert.match(
      schedule,
      /const REVIEW_SCRIPT = "volute intentions review-due"/,
      "the spirit's provisioned schedule must invoke the registered noun",
    );
  });
});
