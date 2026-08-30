import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { log } from "./logger.js";

export type SessionRecord = {
  sessionId: string;
  /**
   * True once this pointer has been known to reference a transcript holding real
   * conversation — a completed turn, a rotation tail, or a seeded tail.
   *
   * The pointer is stamped the moment the SDK emits a session id, which is before
   * anything has been said in it. A session created at startup that never carries a
   * turn therefore leaves a pointer with no transcript behind it, and the next start
   * used to read that as amnesia and tell the mind it had lost context it never had
   * (#769). This flag is the difference: an uncommitted pointer whose transcript is
   * missing had nothing to lose, while a committed one really did.
   *
   * Sticky for the life of the pointer — resume and rotation both carry existing
   * content forward, so it is only cleared by deleting the pointer (a genuine reset).
   * Legacy files with no field read as `false`. That is a deliberate trade in one
   * direction: an install upgrading into this fix carries exactly the phantom
   * never-turned pointers the bug describes, so reading the absent field as "had
   * content" would fire the false notice one more time. The cost is that a legacy
   * pointer that *did* have content, and whose transcript vanishes before its first
   * post-upgrade turn completes, has its genuine loss swallowed once. One session, and
   * it closes at that turn.
   */
  committed: boolean;
};

/**
 * Whether a pointer whose transcript has gone missing represents context the mind
 * actually lost — the question the amnesia notice turns on.
 *
 * Both directions matter and neither is the safe default. True for a session that held
 * conversation is #367: never lose context silently. False for a session that never
 * carried a turn is #769: never claim a loss that didn't happen. An absent record is
 * not a loss either — there was no pointer to lose.
 */
export function lostRealContext(record: SessionRecord | undefined): boolean {
  return record?.committed === true;
}

export type SessionStore = {
  load(name: string): SessionRecord | undefined;
  save(name: string, id: string, committed?: boolean): void;
  delete(name: string): void;
};

export function createSessionStore(sessionsDir: string): SessionStore {
  function filePath(name: string): string {
    return resolvePath(sessionsDir, `${name}.json`);
  }

  return {
    load(name: string): SessionRecord | undefined {
      try {
        const data = JSON.parse(readFileSync(filePath(name), "utf-8"));
        if (typeof data.sessionId !== "string") return undefined;
        return { sessionId: data.sessionId, committed: data.committed === true };
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          log("mind", `failed to load session file for "${name}":`, err);
        }
        return undefined;
      }
    },

    save(name: string, id: string, committed = false) {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(filePath(name), JSON.stringify({ sessionId: id, committed }));
    },

    delete(name: string) {
      try {
        const path = filePath(name);
        if (existsSync(path)) unlinkSync(path);
      } catch (err) {
        log("mind", `failed to delete session file for "${name}":`, err);
      }
    },
  };
}
