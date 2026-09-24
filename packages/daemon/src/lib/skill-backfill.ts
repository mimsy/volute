import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { chownMindDir } from "./mind/isolation.js";
import { mindDir, readRegistry, stateDir } from "./mind/registry.js";
import {
  getSharedSkill,
  getStandardSkillsWithExtensions,
  installSkill,
  mindSkillsDir,
  parseSkillMd,
  removeBinShim,
  removeHookShims,
} from "./skills.js";
import { gitExec } from "./util/exec.js";
import log from "./util/logger.js";

const blog = log.child("skill-backfill");

/**
 * Skills that became standard after minds already existed. New minds get them from the
 * default set; each existing mind is offered them exactly once, here.
 */
export const BACKFILLED_SKILLS = ["resonance"];

const LEDGER_FILE = "skill-backfill.json";

/**
 * Per skill: "done" once it has been offered (installed, found installed, or found
 * removed), "installing" while an install is under way — so an install cut short by a
 * daemon restart is recognised as ours on the next start, cleaned up and retried,
 * instead of its leftovers being mistaken for the mind's own skill.
 */
type LedgerState = "done" | "installing";
type Ledger = Record<string, LedgerState>;

function readLedger(name: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir(name), LEDGER_FILE), "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeLedger(name: string, ledger: Ledger): void {
  const dir = stateDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Mark every backfilled skill as already offered, for a mind created now. It got the
 * default set (or deliberately didn't, with `--skills`) at creation, and the backfill is
 * only for minds that predate these skills.
 */
export function seedSkillBackfillLedger(name: string, skills = BACKFILLED_SKILLS): void {
  writeLedger(name, Object.fromEntries(skills.map((id) => [id, "done"])));
}

/**
 * Whether the mind has ever removed this skill: its SKILL.md deleted in a commit, under
 * any template's skills dir — `volute skill uninstall` or by hand, before or after a
 * template switch moved it.
 */
async function wasRemoved(dir: string, skillId: string): Promise<boolean> {
  try {
    const out = await gitExec(
      [
        "log",
        "--diff-filter=D",
        "--format=%H",
        "-n",
        "1",
        "--",
        `:(glob)home/**/skills/${skillId}/SKILL.md`,
      ],
      { cwd: dir },
    );
    return out.trim().length > 0;
  } catch {
    return false; // no history to go on
  }
}

/**
 * Undo what a failed install left behind (files copied, shims written, but no commit and
 * no .upstream.json), so the next daemon start retries from a clean slate instead of
 * finding a directory and calling it installed.
 */
async function removeHalfInstalled(dir: string, skillDir: string, skillId: string) {
  if (!existsSync(skillDir) || existsSync(join(skillDir, ".upstream.json"))) return;
  try {
    const skillMd = join(skillDir, "SKILL.md");
    const { bin } = existsSync(skillMd)
      ? parseSkillMd(readFileSync(skillMd, "utf-8"))
      : { bin: null };
    removeHookShims(dir, skillId);
    if (bin) removeBinShim(dir, bin);
    rmSync(skillDir, { recursive: true, force: true });
    // Drop anything installSkill had already staged for these paths.
    await gitExec(["add", "-A", "--", relative(dir, skillDir), join("home", ".local")], {
      cwd: dir,
    }).catch(() => {});
  } catch (err) {
    blog.warn(`failed to clean up a half-installed ${skillId}`, log.errorData(err));
  }
}

/**
 * Install each backfilled skill into every existing sprouted mind that has never had it.
 *
 * "Once" is kept in a per-mind ledger (`stateDir/<name>/skill-backfill.json`): a skill is
 * recorded when it is installed, or found already installed, or found to have been
 * removed before this ran — so a mind that removes it, then or later, keeps it removed.
 * A failed install is cleaned up, not recorded, and retried on the next start. A skill
 * the admin has taken out of the default set is not backfilled at all, and minds created
 * after it joined the defaults are seeded as already offered.
 *
 * Seeds are skipped (they get the full default set when they sprout), as is the spirit,
 * whose skill set is managed separately. `shouldStop` is checked between minds.
 */
export async function backfillStandardSkills(
  skills = BACKFILLED_SKILLS,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const defaults = new Set(getStandardSkillsWithExtensions());
  const wanted: string[] = [];
  for (const id of skills) {
    if (defaults.has(id) && (await getSharedSkill(id))) wanted.push(id);
  }
  if (wanted.length === 0) return;

  for (const mind of await readRegistry()) {
    if (shouldStop()) return;
    if (mind.mindType === "spirit" || mind.stage === "seed") continue;
    const dir = mind.dir ?? mindDir(mind.name);
    if (!existsSync(dir)) continue;

    const ledger = readLedger(mind.name);
    for (const id of wanted) {
      if (ledger[id] === "done") continue;
      const skillDir = join(mindSkillsDir(dir), id);
      const installed = () => existsSync(join(skillDir, ".upstream.json"));
      // installSkill writes .upstream.json last, so it marks a complete install.
      if (installed()) {
        ledger[id] = "done";
        writeLedger(mind.name, ledger);
        continue;
      }
      if (ledger[id] === "installing") {
        // Our own install, cut short: clear its leftovers and go again.
        await removeHalfInstalled(dir, skillDir, id);
      } else if (existsSync(skillDir)) {
        // Not ours (a mind's own skill by the same name): leave it, and don't record it.
        blog.warn(`${mind.name} has its own ${id} directory; not installing over it`);
        continue;
      } else if (await wasRemoved(dir, id)) {
        ledger[id] = "done";
        writeLedger(mind.name, ledger);
        continue;
      }

      ledger[id] = "installing";
      writeLedger(mind.name, ledger);
      try {
        await installSkill(mind.name, dir, id);
        blog.info(`installed ${id} for ${mind.name}`);
      } catch (err) {
        blog.warn(`failed to install ${id} for ${mind.name}`, log.errorData(err));
        await removeHalfInstalled(dir, skillDir, id);
      } finally {
        await chownMindDir(dir, mind.name).catch((err) =>
          blog.warn(`failed to chown ${mind.name} after backfill`, log.errorData(err)),
        );
      }
      if (installed()) ledger[id] = "done";
      else delete ledger[id];
      writeLedger(mind.name, ledger);
    }
  }
}
