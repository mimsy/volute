import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../../packages/daemon/src/lib/util/exec.js";
import { cleanGitEnv } from "./test-git-env.js";

/** Create a minimal mind git repo at the given directory (home/.claude/skills/, .gitkeep, git init+commit) */
export async function createMindGitRepo(dir: string): Promise<void> {
  const skillsDir = join(dir, "home", ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(dir, "home", ".gitkeep"), "");

  const env = cleanGitEnv();
  await exec("git", ["init"], { cwd: dir, env });
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: dir, env });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir, env });
  await quietGitMaintenance(dir);
  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, env });
}

/**
 * Stop a test repo's commits from spawning `git maintenance run --auto --detach`. That
 * grandchild outlives the commit that started it, keeps the repo as its cwd, and works on
 * `.git` by relative path — so a test that wipes or re-creates `.git` (or the whole repo)
 * right after a commit can have it write into the new one: a fresh repo whose HEAD then
 * names an object it doesn't have. Repos copied from this one inherit the setting.
 */
export async function quietGitMaintenance(dir: string): Promise<void> {
  const env = cleanGitEnv();
  await exec("git", ["config", "maintenance.auto", "false"], { cwd: dir, env });
  await exec("git", ["config", "gc.auto", "0"], { cwd: dir, env });
}
