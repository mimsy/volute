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
  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, env });
}
