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

export type SessionStore = {
  load(name: string): string | undefined;
  save(name: string, threadId: string): void;
  delete(name: string): void;
};

export function createSessionStore(sessionsDir: string): SessionStore {
  function filePath(name: string): string {
    return resolvePath(sessionsDir, `${name}.json`);
  }

  return {
    load(name: string): string | undefined {
      const path = filePath(name);
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        return typeof data.threadId === "string" ? data.threadId : undefined;
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

    save(name: string, threadId: string) {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(filePath(name), JSON.stringify({ threadId }));
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
