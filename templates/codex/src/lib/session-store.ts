import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";
import { log, warn } from "./logger.js";

export type SessionRecord = {
  threadId: string;
  /**
   * True once this pointer has been known to reference a rollout holding real
   * conversation — a completed turn, a rotation tail, or a seeded tail. The claude
   * template's field of the same name, for the same reason (#769): the pointer is stamped
   * at `thread.started`, before anything has been said, so a thread whose first turn
   * never completed leaves a pointer with nothing behind it. A missing rollout under an
   * uncommitted pointer lost nothing; under a committed one it lost real context.
   *
   * Sticky for the life of the pointer — only deleting the pointer clears it. Legacy
   * `{ threadId }` files read as `false`, the same one-direction trade the claude store
   * makes: a genuine loss on a pre-upgrade pointer is swallowed once rather than telling
   * a mind about a loss that may never have happened.
   */
  committed: boolean;
};

/**
 * Whether a pointer whose rollout has gone missing represents context the mind actually
 * lost — the question the `context_lost` notice turns on (#367 one way, #769 the other).
 */
export function lostRealContext(record: SessionRecord | undefined): boolean {
  return record?.committed === true;
}

export type SessionStore = {
  load(name: string): SessionRecord | undefined;
  save(name: string, threadId: string, committed?: boolean): void;
  delete(name: string): void;
};

export function createSessionStore(sessionsDir: string): SessionStore {
  function filePath(name: string): string {
    return resolvePath(sessionsDir, `${name}.json`);
  }

  return {
    load(name: string): SessionRecord | undefined {
      const path = filePath(name);
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (typeof data.threadId !== "string") return undefined;
        return { threadId: data.threadId, committed: data.committed === true };
      } catch (err: any) {
        if (err?.code === "ENOENT") return undefined;
        // Corrupt or unreadable file — rename it so a fresh session can be saved
        warn("mind", `corrupt session file for "${name}", renaming to .corrupt:`, err);
        try {
          renameSync(path, `${path}.corrupt`);
        } catch {
          // Best effort — ignore rename failures
        }
        return undefined;
      }
    },

    save(name: string, threadId: string, committed = false) {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(filePath(name), JSON.stringify({ threadId, committed }));
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
