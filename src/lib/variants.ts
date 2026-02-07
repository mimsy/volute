import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  pid: number | null;
  created: string;
};

function variantsPath(): string {
  const home = process.env.VOLUTE_HOME || resolve(homedir(), ".volute");
  return resolve(home, "variants.json");
}

function readAllVariants(): Record<string, Variant[]> {
  const path = variantsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeAllVariants(all: Record<string, Variant[]>) {
  const home = process.env.VOLUTE_HOME || resolve(homedir(), ".volute");
  mkdirSync(home, { recursive: true });
  writeFileSync(variantsPath(), `${JSON.stringify(all, null, 2)}\n`);
}

export function readVariants(agentName: string): Variant[] {
  return readAllVariants()[agentName] ?? [];
}

export function writeVariants(agentName: string, variants: Variant[]) {
  const all = readAllVariants();
  if (variants.length === 0) {
    delete all[agentName];
  } else {
    all[agentName] = variants;
  }
  writeAllVariants(all);
}

export function addVariant(agentName: string, variant: Variant) {
  const variants = readVariants(agentName);
  const filtered = variants.filter((v) => v.name !== variant.name);
  filtered.push(variant);
  writeVariants(agentName, filtered);
}

export function removeVariant(agentName: string, name: string) {
  const variants = readVariants(agentName);
  writeVariants(
    agentName,
    variants.filter((v) => v.name !== name),
  );
}

export function findVariant(agentName: string, name: string): Variant | undefined {
  return readVariants(agentName).find((v) => v.name === name);
}

export function removeAllVariants(agentName: string) {
  const all = readAllVariants();
  delete all[agentName];
  writeAllVariants(all);
}

export async function checkHealth(port: number): Promise<{ ok: boolean; name?: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { name: string };
    return { ok: true, name: data.name };
  } catch {
    return { ok: false };
  }
}

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export function validateBranchName(branch: string): string | null {
  if (!SAFE_BRANCH_RE.test(branch)) {
    return `Invalid branch name: ${branch}. Only alphanumeric, '.', '_', '-', '/' allowed.`;
  }
  if (branch.includes("..")) {
    return `Invalid branch name: ${branch}. '..' not allowed.`;
  }
  return null;
}
