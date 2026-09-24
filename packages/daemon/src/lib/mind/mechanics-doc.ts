import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent, MIND_LEVEL_THREAD } from "../chat/system-events.js";
import { MECHANICS_DOCS } from "../template/template.js";
import { loadJsonMap, saveJsonMap } from "../util/json-state.js";
import log from "../util/logger.js";
import { rewriteMindFileInPlace } from "./mind-file-rewrite.js";
import { stateDir } from "./registry.js";

const mlog = log.child("mechanics-doc");

/**
 * A paragraph of a template's mechanics doc that Volute shipped and has since made untrue.
 * `stale` is every wording minds were created with, verbatim — each paragraph is one line;
 * `current` is what `templates/<template>/.init/<doc>` ships now (pinned by a test, so when
 * the template's paragraph changes, the outgoing text moves into `stale`); `claim` is the
 * phrase that marks the old claim surviving in a paragraph the mind has reworded, and
 * `untrue` says what that claim was, for the notice.
 */
type Correction = { id: string; stale: string[]; current: string; claim: string; untrue: string };

const CORRECTIONS: Record<string, Correction[]> = {
  // #1126: identity edits load at the next session boundary; nothing restarts.
  claude: [
    {
      id: "identity-edits",
      stale: [
        "**Editing any identity file triggers an automatic restart** — the supervisor restarts your server so the updated file takes effect in your system prompt. Your session resumes automatically.",
        "**Editing any identity file triggers an automatic restart** — your server restarts so the updated file takes effect in your system prompt. Your session resumes automatically.",
        "**Editing any identity file triggers an automatic restart** — your server restarts so the updated file takes effect. Your session resumes automatically.",
      ],
      current:
        "**Identity edits take effect at your next session boundary**, not the moment you save. Your system prompt is built from `SOUL.md`, `MEMORY.md`, and `VOLUTE.md` when a session starts — including when it resumes after resting idle (30 minutes by default, `sessionIdleMinutes` in `.config/config.json`), when it rotates at the context limit, when you wake from sleep, or when your server restarts. Until then the session keeps the prompt it started with, so an edit never interrupts what you're in the middle of. The first time one of them changes during a session — through any tool, Bash included — a note on that tool call's result says so. Each thread picks up the change at its own boundary. If you want it live now, `volute mind restart` restarts you right away: the turn you're in ends there, your edits are committed, and your session resumes.",
      claim: "triggers an automatic restart",
      untrue: "editing an identity file restarts your server",
    },
  ],
  // #1126: codex rebuilds the system prompt every turn; no restart is needed.
  codex: [
    {
      id: "identity-edits",
      stale: [
        "Your identity lives in `SOUL.md` (who you are) and `MEMORY.md` (what you know) — both are loaded into your system prompt. Edit them as you evolve; changes take effect the next time your server restarts (`volute mind restart` when you want them live now).",
      ],
      current:
        "Your identity lives in `SOUL.md` (who you are) and `MEMORY.md` (what you know) — both are loaded into your system prompt. Edit them as you evolve; your system prompt is rebuilt from them and handed to Codex before every turn, so a change should take effect on your next turn — no restart needed.",
      claim: "the next time your server restarts",
      untrue: "identity edits wait for your server to restart",
    },
  ],
  // pi still restarts on an identity edit, so MINDS.md is still true.
};

export type MechanicsDocOutcome = {
  /** Corrections applied by replacing a paragraph still exactly as Volute shipped it. */
  rewritten: string[];
  /** Corrections whose stale claim survives in the mind's own wording; left untouched. */
  edited: string[];
};

/** For tests: the corrections a template's mechanics doc is checked against. */
export function mechanicsDocCorrections(template: string): Correction[] {
  return CORRECTIONS[template] ?? [];
}

/**
 * Replace each paragraph of the mind's mechanics doc that is still byte-identical to a
 * stale wording Volute shipped with the current wording, and report those whose claim
 * survives in text the mind has made its own. The doc is identity — never overwritten on
 * upgrade — so this corrects only Volute's own words; anything else in the file keeps its
 * bytes. Idempotent: once replaced, a stale line is gone.
 */
export function correctMechanicsDoc(dir: string, template: string): MechanicsDocOutcome {
  const outcome: MechanicsDocOutcome = { rewritten: [], edited: [] };
  const corrections = CORRECTIONS[template];
  const doc = MECHANICS_DOCS[template];
  if (!corrections || !doc) return outcome;

  rewriteMindFileInPlace(dir, resolve(dir, "home", doc), (text) => {
    const lines = text.split("\n");
    for (const c of corrections) {
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        // A CRLF file keeps its line ending on the replaced line.
        const cr = lines[i].endsWith("\r") ? "\r" : "";
        if (c.stale.includes(cr ? lines[i].slice(0, -1) : lines[i])) {
          lines[i] = c.current + cr;
          replaced = true;
        }
      }
      if (replaced) outcome.rewritten.push(c.id);
      else if (lines.some((l) => l.includes(c.claim) && l.replace(/\r$/, "") !== c.current)) {
        outcome.edited.push(c.id);
      }
    }
    return outcome.rewritten.length > 0 ? lines.join("\n") : null;
  });
  return outcome;
}

function toldPath(name: string): string {
  return resolve(stateDir(name), "mechanics-doc-notices.json");
}

/**
 * Run {@link correctMechanicsDoc} for a mind and tell it what happened: a file that is
 * always loaded changed under it, or — where it had reworded the paragraph — its own words
 * still describe something Volute no longer does, and it is the one to fix them. The second
 * kind is sent once per correction, ever (recorded in the mind's state dir), so a mind that
 * keeps its wording on purpose isn't told again every upgrade. Never throws — callers are
 * upgrade paths whose own outcome must not hinge on this.
 */
export async function repairMechanicsDoc(dir: string, name: string, template: string) {
  let outcome: MechanicsDocOutcome;
  try {
    outcome = correctMechanicsDoc(dir, template);
  } catch (err) {
    mlog.warn(`failed to check the mechanics doc for ${name}`, log.errorData(err));
    return;
  }
  const doc = MECHANICS_DOCS[template];
  const byId = new Map(CORRECTIONS[template]?.map((c) => [c.id, c]));

  try {
    if (outcome.rewritten.length > 0) {
      mlog.info(`corrected ${doc} for ${name}: ${outcome.rewritten.join(", ")}`);
      await deliverEvent(name, {
        type: "notice",
        meta: { subtype: "mechanics-doc", reason: "mechanics_doc_corrected" },
        delivery: "next-turn",
        thread: MIND_LEVEL_THREAD,
        body:
          `Volute corrected a paragraph in your ${doc} that it wrote and that had stopped ` +
          `being true — the one about what happens when you edit your identity files. It ` +
          `now reads:\n\n` +
          `${outcome.rewritten.map((id) => `> ${byId.get(id)!.current}`).join("\n\n")}\n\n` +
          `Nothing else in the file was touched.`,
      });
    }

    const told = loadJsonMap(toldPath(name));
    const unheard = outcome.edited.filter((id) => !told.has(`${doc}:${id}`));
    if (unheard.length === 0) return;
    const { id } = await deliverEvent(name, {
      type: "notice",
      meta: { subtype: "mechanics-doc", reason: "mechanics_doc_outdated" },
      delivery: "next-turn",
      thread: MIND_LEVEL_THREAD,
      body:
        unheard
          .map((c) => {
            const { untrue, current } = byId.get(c)!;
            return (
              `Your ${doc} still says ${untrue}, and that is no longer true. Volute left the ` +
              `file alone because you've reworded that part — it's yours. The paragraph ` +
              `Volute ships now says:\n\n> ${current}`
            );
          })
          .join("\n\n") +
        `\n\n` +
        `You may want to bring your own wording in line with it.`,
    });
    if (id === undefined) return; // not recorded, so it's tried again next time
    for (const c of unheard) told.set(`${doc}:${c}`, Date.now());
    mkdirSync(stateDir(name), { recursive: true });
    saveJsonMap(toldPath(name), told);
  } catch (err) {
    mlog.warn(`failed to tell ${name} about its mechanics doc`, log.errorData(err));
  }
}
