import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  pid: number | null;
  created: string;
};

function variantsPath(projectRoot: string): string {
  return resolve(projectRoot, ".molt", "variants.json");
}

export function readVariants(projectRoot: string): Variant[] {
  const path = variantsPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

export function writeVariants(projectRoot: string, variants: Variant[]) {
  const path = variantsPath(projectRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(variants, null, 2)}\n`);
}

export function addVariant(projectRoot: string, variant: Variant) {
  const variants = readVariants(projectRoot);
  // Remove any existing entry with the same name
  const filtered = variants.filter((v) => v.name !== variant.name);
  filtered.push(variant);
  writeVariants(projectRoot, filtered);
}

export function removeVariant(projectRoot: string, name: string) {
  const variants = readVariants(projectRoot);
  writeVariants(
    projectRoot,
    variants.filter((v) => v.name !== name),
  );
}

export function findVariant(projectRoot: string, name: string): Variant | undefined {
  return readVariants(projectRoot).find((v) => v.name === name);
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
