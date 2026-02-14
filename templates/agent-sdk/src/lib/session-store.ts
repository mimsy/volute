import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { log } from "./logger.js";

export type SessionStore = {
  load(name: string): string | undefined;
  save(name: string, id: string): void;
  delete(name: string): void;
};

export function createSessionStore(sessionsDir: string): SessionStore {
  function filePath(name: string): string {
    return resolvePath(sessionsDir, `${name}.json`);
  }

  return {
    load(name: string): string | undefined {
      try {
        const data = JSON.parse(readFileSync(filePath(name), "utf-8"));
        return typeof data.sessionId === "string" ? data.sessionId : undefined;
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          log("agent", `failed to load session file for "${name}":`, err);
        }
        return undefined;
      }
    },

    save(name: string, id: string) {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(filePath(name), JSON.stringify({ sessionId: id }));
    },

    delete(name: string) {
      try {
        const path = filePath(name);
        if (existsSync(path)) unlinkSync(path);
      } catch (err) {
        log("agent", `failed to delete session file for "${name}":`, err);
      }
    },
  };
}
