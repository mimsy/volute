import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  ARCHIVE_INIT_LEDGER,
  createExportArchive,
  extractArchive,
  overlayArchiveHome,
} from "../packages/daemon/src/lib/mind/archive.js";
import {
  readInitLedger,
  readInitLedgerFile,
  seedInitLedger,
} from "../packages/daemon/src/lib/mind/init-ledger.js";
import { mindDir, stateDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  applyInitFiles,
  backfillInitInfrastructure,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listInfrastructureOnDisk,
} from "../packages/daemon/src/lib/template/template.js";

/**
 * A home-only export/import round trip has to carry `home/.local/` — the mind's
 * hooks and bin shims — or it quietly reverts them to stock (#1013).
 *
 * Two authored things have to survive it, and neither is expressible in an
 * archive that omits the subtree: a hook the mind **edited** (`.local/` is a
 * namespace minds are invited to modify, which is why the upgrade backfill never
 * overwrites a hook that is present), and a hook the mind **deleted** (#811 made
 * that removal durable against the backfill; it must also be durable across a
 * move to another host).
 *
 * A third thing has to *not* survive it: an absence that was never a refusal.
 * A hook that shipped after the archive was written is missing from it for
 * reasons that have nothing to do with the mind, and reading that as authorship
 * would withhold machinery from a mind that never declined it — #808, the error
 * the ledger exists to avoid making in the other direction.
 *
 * Both branches of the export are exercised, because which one runs depends only
 * on whether the mind's home happens to be a git repo — a distinction no one
 * chose, and the one this test exists to make invisible.
 */

/** A hook the mind deletes: in the exporting host's ledger, absent from disk. */
const REFUSED = ".local/hooks/pre-prompt/notices.ts";
/** A hook the mind edits. */
const EDITED = ".local/hooks/startup-context.ts";
/** A hook that ships *after* the export: absent from the archive and its ledger. */
const NEWER = ".local/hooks/pre-prompt/turn-context.ts";
const SHIM = ".local/bin/volute";
const EDIT_MARK = "// the mind rewrote this hook\n";

const scratchDirs: string[] = [];
const mindNames: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "volute-home-local-"));
  scratchDirs.push(dir);
  return dir;
}

/** A mind directory composed from the real template, as `mind create` leaves it. */
function composedMind(dir: string, name: string): string {
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
  try {
    copyTemplateToDir(composedDir, dir, name, manifest);
    seedInitLedger(name, applyInitFiles(dir));
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  return resolve(dir, "home");
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const name of mindNames) {
    rmSync(mindDir(name), { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
  }
});

describe("home-only archives carry home/.local/", () => {
  for (const git of [true, false]) {
    const label = git ? "a git home" : "a non-git home";

    /**
     * Export a mind that has edited one hook and deleted another, then rebuild it
     * the way `importFromHomeOnlyArchive` does: a fresh template, the archive's
     * `home/` over the top, and a ledger spanning both hosts' records.
     */
    function roundTrip(name: string) {
      const importedName = `${name}-imported`;
      mindNames.push(name, importedName);

      const source = mindDir(name);
      const sourceHome = composedMind(source, name);

      // An exporting host whose template predates NEWER: it never gave the mind
      // that hook, so its ledger cannot record it.
      rmSync(resolve(sourceHome, NEWER));
      seedInitLedger(name, listInfrastructureOnDisk(sourceHome));

      writeFileSync(
        resolve(sourceHome, EDITED),
        EDIT_MARK + readFileSync(resolve(sourceHome, EDITED), "utf-8"),
      );
      rmSync(resolve(sourceHome, REFUSED));
      assert.ok(
        readInitLedger(name).has(REFUSED),
        "the removed hook must be a recorded refusal before the export",
      );

      if (git) execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
      assert.equal(
        existsSync(resolve(source, ".git")),
        git,
        `${label} must exercise the branch it names`,
      );

      const zip = createExportArchive({ name, template: "claude" });
      const archivePath = resolve(scratch(), `${name}.volute`);
      zip.writeZip(archivePath);
      const tempDir = scratch();
      const { mindDir: archived } = extractArchive(archivePath, tempDir);

      const dest = resolve(scratch(), importedName);
      const destHome = composedMind(dest, importedName);
      const given = readInitLedgerFile(resolve(tempDir, ARCHIVE_INIT_LEDGER), importedName);
      overlayArchiveHome(resolve(archived, "home"), destHome, given);
      seedInitLedger(importedName, [...given, ...listInfrastructureOnDisk(destHome)]);

      return { entries: zip.getEntries().map((e) => e.entryName), destHome, importedName };
    }

    it(`exports the mind's own hooks from ${label}`, () => {
      const { entries } = roundTrip(`home-local-export-${git ? "git" : "nogit"}`);

      assert.ok(
        entries.includes(`mind/home/${EDITED}`),
        "a hook the mind edited must be in the archive",
      );
      assert.ok(
        entries.includes(`mind/home/${SHIM}`),
        "the mind's bin shims must be in the archive",
      );
      assert.ok(
        !entries.includes(`mind/home/${REFUSED}`),
        "a hook the mind deleted must be absent from the archive",
      );
      assert.ok(
        entries.includes(ARCHIVE_INIT_LEDGER),
        "the archive must carry the ledger that says which absences were refusals",
      );
    });

    it(`preserves an edited hook through a round trip from ${label}`, () => {
      const { destHome } = roundTrip(`home-local-edit-${git ? "git" : "nogit"}`);

      const landed = readFileSync(resolve(destHome, EDITED), "utf-8");
      assert.ok(
        landed.startsWith(EDIT_MARK),
        "the imported mind must keep its own hook, not the template's",
      );
    });

    it(`keeps the mind's bin shims executable through ${label}`, () => {
      const { destHome } = roundTrip(`home-local-mode-${git ? "git" : "nogit"}`);

      assert.ok(
        (statSync(resolve(destHome, SHIM)).mode & 0o111) !== 0,
        "the volute wrapper is only useful executable",
      );
    });

    it(`does not reinstall a hook the mind deleted, from ${label}`, () => {
      const { destHome, importedName } = roundTrip(`home-local-refusal-${git ? "git" : "nogit"}`);

      assert.ok(
        !existsSync(resolve(destHome, REFUSED)),
        "a hook the mind deleted must not arrive back as the template's copy",
      );

      // And it stays gone: the refusal has to outlive the import itself, or the
      // mind re-acquires the hook on its first upgrade on the new host.
      const { added, withheld } = backfillInitInfrastructure(destHome, "claude", importedName);
      assert.ok(withheld.includes(REFUSED), "the refusal must survive onto the new host's ledger");
      assert.ok(!added.includes(REFUSED));
      assert.ok(!existsSync(resolve(destHome, REFUSED)));
    });

    it(`installs a hook that shipped after the archive, from ${label}`, () => {
      const { destHome } = roundTrip(`home-local-newer-${git ? "git" : "nogit"}`);

      assert.ok(
        existsSync(resolve(destHome, NEWER)),
        "an absence the exporting host never gave is not a refusal — #808",
      );
    });
  }

  it("ignores a ledger entry that points outside the infrastructure namespace", () => {
    // The ledger travels inside an archive, so it is attacker-controllable, and
    // the only thing overlayArchiveHome does with it is delete. A path that
    // resolves back out of `.local/` must be judged on where it lands, not on
    // how it is spelled.
    const name = "home-local-traversal";
    mindNames.push(name);
    const destHome = composedMind(mindDir(name), name);
    const archiveHome = resolve(scratch(), "home");
    mkdirSync(archiveHome, { recursive: true });

    overlayArchiveHome(archiveHome, destHome, [
      ".local/../.config",
      "../../../etc",
      ".config/volute.json",
    ]);

    assert.ok(
      existsSync(resolve(destHome, ".config")),
      "only `.local/` is the archive's to remove",
    );
    assert.ok(existsSync(resolve(destHome, ".local/hooks/startup-context.ts")));
  });

  it("wires the home-only import through overlayArchiveHome and reseeds from disk", () => {
    // The round trip above composes the real units; this pins the order
    // lifecycle.ts calls them in. Overlaying with a plain recursive copy would
    // leave the template's `.local/` underneath the archive's, and seeding only
    // from applyInitFiles would describe a tree that is no longer there.
    const src = readFileSync(
      resolve(import.meta.dirname, "../packages/daemon/src/lib/mind/lifecycle.ts"),
      "utf-8",
    );
    const homeOnly = src.slice(src.indexOf("async function importFromHomeOnlyArchive"));
    assert.ok(homeOnly.length > 0, "importFromHomeOnlyArchive has been renamed");

    const overlay = homeOnly.indexOf("overlayArchiveHome(");
    const reseed = homeOnly.indexOf("seedInitLedger(name, [...given, ...listInfrastructureOnDisk(");
    assert.ok(overlay > 0, "the home-only import must overlay through overlayArchiveHome");
    assert.ok(
      homeOnly.indexOf("isInitInfrastructure") > 0,
      "the carried ledger is archive content and must be filtered to `.local/`",
    );
    assert.ok(
      reseed > overlay,
      "the ledger must be reseeded after the overlay, spanning both hosts",
    );
  });
});
