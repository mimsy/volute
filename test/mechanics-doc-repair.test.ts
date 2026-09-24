import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  correctMechanicsDoc,
  mechanicsDocCorrections,
  repairMechanicsDoc,
} from "../packages/daemon/src/lib/mind/mechanics-doc.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

const templatesRoot = resolve(import.meta.dirname, "../templates");
const DOCS = { claude: "CLAUDE.md", codex: "AGENTS.md", pi: "MINDS.md" } as const;

const [claude] = mechanicsDocCorrections("claude");
const [codex] = mechanicsDocCorrections("codex");

function docWith(paragraph: string): string {
  return `# Mechanics\n\nSomething the mind wrote.\n\n${paragraph}\n\nMore of its own words.\n`;
}

function mindDirWithDoc(template: keyof typeof DOCS, text: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "mechanics-doc-"));
  mkdirSync(resolve(dir, "home"), { recursive: true });
  writeFileSync(resolve(dir, "home", DOCS[template]), text);
  return dir;
}

function readDoc(dir: string, template: keyof typeof DOCS): string {
  return readFileSync(resolve(dir, "home", DOCS[template]), "utf-8");
}

async function noticesFor(mind: string, reason: string) {
  const db = await getDb();
  return db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.mind, mind),
        sql`json_extract(${systemEvents.meta}, '$.reason') = ${reason}`,
      ),
    )
    .all();
}

describe("mechanics doc corrections", () => {
  // When a template's paragraph changes again, this fails: update `current`, and move the
  // outgoing text into `stale` — minds created today will be carrying it.
  for (const template of ["claude", "codex"] as const) {
    it(`${template}: the current wording is what the template ships`, () => {
      const shipped = readFileSync(
        resolve(templatesRoot, template, ".init", DOCS[template]),
        "utf-8",
      );
      for (const c of mechanicsDocCorrections(template)) {
        assert.ok(shipped.split("\n").includes(c.current), `${template} ships ${c.id}`);
        for (const s of c.stale) assert.ok(!shipped.includes(s));
      }
    });
  }

  it("pi's doc is left alone — pi still restarts on an identity edit", () => {
    const shipped = readFileSync(resolve(templatesRoot, "pi/.init/MINDS.md"), "utf-8");
    const dir = mindDirWithDoc("pi", shipped);
    assert.deepEqual(correctMechanicsDoc(dir, "pi"), { rewritten: [], edited: [] });
    assert.equal(readDoc(dir, "pi"), shipped);
  });
});

describe("correctMechanicsDoc", () => {
  for (const stale of claude.stale) {
    it(`claude: replaces a verbatim stale paragraph (${stale.slice(60, 100)}…)`, () => {
      const dir = mindDirWithDoc("claude", docWith(stale));
      const ino = statSync(resolve(dir, "home/CLAUDE.md")).ino;
      assert.deepEqual(correctMechanicsDoc(dir, "claude"), {
        rewritten: ["identity-edits"],
        edited: [],
      });
      assert.equal(readDoc(dir, "claude"), docWith(claude.current));
      // Rewritten in place, so the file (and its ownership) stays the mind's.
      assert.equal(statSync(resolve(dir, "home/CLAUDE.md")).ino, ino);
    });
  }

  it("codex: replaces the verbatim stale paragraph", () => {
    const dir = mindDirWithDoc("codex", docWith(codex.stale[0]));
    assert.deepEqual(correctMechanicsDoc(dir, "codex").rewritten, ["identity-edits"]);
    assert.equal(readDoc(dir, "codex"), docWith(codex.current));
  });

  it("handles CRLF line endings, keeping them", () => {
    const crlf = (t: string) => t.replaceAll("\n", "\r\n");
    const dir = mindDirWithDoc("claude", crlf(docWith(claude.stale[2])));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), {
      rewritten: ["identity-edits"],
      edited: [],
    });
    assert.equal(readDoc(dir, "claude"), crlf(docWith(claude.current)));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
  });

  it("is idempotent", () => {
    const dir = mindDirWithDoc("claude", docWith(claude.stale[2]));
    correctMechanicsDoc(dir, "claude");
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
    assert.equal(readDoc(dir, "claude"), docWith(claude.current));
  });

  it("leaves a reworded paragraph alone and reports it", () => {
    const edited = docWith(
      "Editing SOUL.md triggers an automatic restart, which I've come to think of as a breath.",
    );
    const dir = mindDirWithDoc("claude", edited);
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), {
      rewritten: [],
      edited: ["identity-edits"],
    });
    assert.equal(readDoc(dir, "claude"), edited);
  });

  it("does nothing when the paragraph was removed, or the doc is already current", () => {
    for (const text of [docWith("I rewrote this whole part."), docWith(claude.current)]) {
      const dir = mindDirWithDoc("claude", text);
      assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
      assert.equal(readDoc(dir, "claude"), text);
    }
  });

  it("does nothing when there is no mechanics doc", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mechanics-doc-"));
    mkdirSync(resolve(dir, "home"));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
  });

  it("never writes through a symlink planted at the doc", () => {
    const outside = mkdtempSync(resolve(tmpdir(), "mechanics-doc-target-"));
    const target = resolve(outside, "victim.md");
    writeFileSync(target, docWith(claude.stale[2]));
    const dir = mkdtempSync(resolve(tmpdir(), "mechanics-doc-"));
    mkdirSync(resolve(dir, "home"));
    symlinkSync(target, resolve(dir, "home/CLAUDE.md"));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
    assert.equal(readFileSync(target, "utf-8"), docWith(claude.stale[2]));
  });

  it("never writes through a hard link to a file elsewhere", () => {
    const outside = mkdtempSync(resolve(tmpdir(), "mechanics-doc-target-"));
    const target = resolve(outside, "victim.md");
    writeFileSync(target, docWith(claude.stale[2]));
    const dir = mkdtempSync(resolve(tmpdir(), "mechanics-doc-"));
    mkdirSync(resolve(dir, "home"));
    linkSync(target, resolve(dir, "home/CLAUDE.md"));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
    assert.equal(readFileSync(target, "utf-8"), docWith(claude.stale[2]));
  });

  it("never writes when home/ resolves outside the mind dir", () => {
    const outside = mkdtempSync(resolve(tmpdir(), "mechanics-doc-target-"));
    writeFileSync(resolve(outside, "CLAUDE.md"), docWith(claude.stale[2]));
    const dir = mkdtempSync(resolve(tmpdir(), "mechanics-doc-"));
    symlinkSync(outside, resolve(dir, "home"));
    assert.deepEqual(correctMechanicsDoc(dir, "claude"), { rewritten: [], edited: [] });
    assert.equal(readFileSync(resolve(outside, "CLAUDE.md"), "utf-8"), docWith(claude.stale[2]));
  });
});

describe("repairMechanicsDoc", () => {
  it("tells the mind what was corrected", async () => {
    const dir = mindDirWithDoc("claude", docWith(claude.stale[2]));
    await repairMechanicsDoc(dir, "mdoc-rewritten", "claude");
    const notices = await noticesFor("mdoc-rewritten", "mechanics_doc_corrected");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].delivery, "next-turn");
    assert.ok(notices[0].body.includes(claude.current));
    await repairMechanicsDoc(dir, "mdoc-rewritten", "claude");
    assert.equal((await noticesFor("mdoc-rewritten", "mechanics_doc_corrected")).length, 1);
  });

  it("tells a mind that reworded the paragraph once, and never edits its file", async () => {
    const edited = docWith("My server restarts — it triggers an automatic restart, I mean.");
    const dir = mindDirWithDoc("claude", edited);
    await repairMechanicsDoc(dir, "mdoc-edited", "claude");
    await repairMechanicsDoc(dir, "mdoc-edited", "claude");
    const notices = await noticesFor("mdoc-edited", "mechanics_doc_outdated");
    assert.equal(notices.length, 1);
    assert.ok(notices[0].body.includes("editing an identity file restarts your server"));
    assert.ok(notices[0].body.includes(claude.current));
    assert.equal(readDoc(dir, "claude"), edited);
    assert.equal((await noticesFor("mdoc-edited", "mechanics_doc_corrected")).length, 0);
  });

  it("says nothing when there is nothing stale", async () => {
    const dir = mindDirWithDoc("claude", docWith(claude.current));
    await repairMechanicsDoc(dir, "mdoc-clean", "claude");
    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "mdoc-clean"))
      .all();
    assert.equal(rows.length, 0);
  });
});
