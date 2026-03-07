import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  created: string;
  running?: boolean;
};

function variantsPath(): string {
  return resolve(voluteHome(), "variants.json");
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
  mkdirSync(voluteHome(), { recursive: true });
  writeFileSync(variantsPath(), `${JSON.stringify(all, null, 2)}\n`);
}

export function readVariants(mindName: string): Variant[] {
  return readAllVariants()[mindName] ?? [];
}

export function writeVariants(mindName: string, variants: Variant[]) {
  const all = readAllVariants();
  if (variants.length === 0) {
    delete all[mindName];
  } else {
    all[mindName] = variants;
  }
  writeAllVariants(all);
}

export function addVariant(mindName: string, variant: Variant) {
  const variants = readVariants(mindName);
  const filtered = variants.filter((v) => v.name !== variant.name);
  filtered.push(variant);
  writeVariants(mindName, filtered);
}

export function removeVariant(mindName: string, name: string) {
  const variants = readVariants(mindName);
  writeVariants(
    mindName,
    variants.filter((v) => v.name !== name),
  );
}

export function findVariant(mindName: string, name: string): Variant | undefined {
  return readVariants(mindName).find((v) => v.name === name);
}

export function setVariantRunning(mindName: string, variantName: string, running: boolean) {
  const all = readAllVariants();
  const variants = all[mindName] ?? [];
  const variant = variants.find((v) => v.name === variantName);
  if (variant) {
    variant.running = running;
    all[mindName] = variants;
    writeAllVariants(all);
  }
}

export function getAllRunningVariants(): Array<{ mindName: string; variant: Variant }> {
  const all = readAllVariants();
  const result: Array<{ mindName: string; variant: Variant }> = [];
  for (const [mindName, variants] of Object.entries(all)) {
    for (const variant of variants) {
      if (variant.running) {
        result.push({ mindName, variant });
      }
    }
  }
  return result;
}

export function removeAllVariants(mindName: string) {
  const all = readAllVariants();
  delete all[mindName];
  writeAllVariants(all);
}

export async function checkHealth(port: number): Promise<{ ok: boolean; name?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
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
