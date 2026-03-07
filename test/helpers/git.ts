import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../../src/lib/exec.js";

/** Create a minimal mind git repo at the given directory (home/.claude/skills/, .gitkeep, git init+commit) */
export async function createMindGitRepo(dir: string): Promise<void> {
  const skillsDir = join(dir, "home", ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(dir, "home", ".gitkeep"), "");

  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-m", "init"], { cwd: dir });
}
