import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { findVariant } from "./variants.js";

export const VOLUTE_HOME = resolve(homedir(), ".volute");
export const AGENTS_DIR = resolve(VOLUTE_HOME, "agents");
const REGISTRY_PATH = resolve(VOLUTE_HOME, "agents.json");

export type AgentEntry = {
  name: string;
  port: number;
  created: string;
};

export function ensureVoluteHome() {
  mkdirSync(AGENTS_DIR, { recursive: true });
}

export function readRegistry(): AgentEntry[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

export function writeRegistry(entries: AgentEntry[]) {
  ensureVoluteHome();
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

export function addAgent(name: string, port: number) {
  const entries = readRegistry();
  const filtered = entries.filter((e) => e.name !== name);
  filtered.push({ name, port, created: new Date().toISOString() });
  writeRegistry(filtered);
}

export function removeAgent(name: string) {
  const entries = readRegistry();
  writeRegistry(entries.filter((e) => e.name !== name));
}

export function findAgent(name: string): AgentEntry | undefined {
  return readRegistry().find((e) => e.name === name);
}

export function agentDir(name: string): string {
  return resolve(AGENTS_DIR, name);
}

export function nextPort(): number {
  const entries = readRegistry();
  const usedPorts = new Set(entries.map((e) => e.port));
  let port = 4100;
  while (usedPorts.has(port)) port++;
  return port;
}

export function resolveAgent(name: string): { entry: AgentEntry; dir: string } {
  // Parse name@variant syntax
  const [baseName, variantName] = name.split("@", 2);

  const entry = findAgent(baseName);
  if (!entry) {
    console.error(`Unknown agent: ${baseName}`);
    process.exit(1);
  }
  const dir = agentDir(baseName);
  if (!existsSync(dir)) {
    console.error(`Agent directory missing: ${dir}`);
    process.exit(1);
  }

  if (variantName) {
    const variant = findVariant(dir, variantName);
    if (!variant) {
      console.error(`Unknown variant: ${variantName} (agent: ${baseName})`);
      process.exit(1);
    }
    return { entry: { ...entry, port: variant.port }, dir };
  }

  return { entry, dir };
}
