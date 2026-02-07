import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { findVariant, readVariants } from "./variants.js";

export function voluteHome(): string {
  return process.env.VOLUTE_HOME || resolve(homedir(), ".volute");
}

export type AgentEntry = {
  name: string;
  port: number;
  created: string;
  running: boolean;
};

export function ensureVoluteHome() {
  mkdirSync(resolve(voluteHome(), "agents"), { recursive: true });
}

export function readRegistry(): AgentEntry[] {
  const registryPath = resolve(voluteHome(), "agents.json");
  if (!existsSync(registryPath)) return [];
  try {
    const entries = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<
      Omit<AgentEntry, "running"> & { running?: boolean }
    >;
    return entries.map((e) => ({ ...e, running: e.running ?? false }));
  } catch {
    return [];
  }
}

export function writeRegistry(entries: AgentEntry[]) {
  ensureVoluteHome();
  const registryPath = resolve(voluteHome(), "agents.json");
  writeFileSync(registryPath, `${JSON.stringify(entries, null, 2)}\n`);
}

export function addAgent(name: string, port: number) {
  const entries = readRegistry();
  const filtered = entries.filter((e) => e.name !== name);
  filtered.push({ name, port, created: new Date().toISOString(), running: false });
  writeRegistry(filtered);
}

export function removeAgent(name: string) {
  const entries = readRegistry();
  writeRegistry(entries.filter((e) => e.name !== name));
}

export function setAgentRunning(name: string, running: boolean) {
  const entries = readRegistry();
  const entry = entries.find((e) => e.name === name);
  if (entry) {
    entry.running = running;
    writeRegistry(entries);
  }
}

export function findAgent(name: string): AgentEntry | undefined {
  return readRegistry().find((e) => e.name === name);
}

export function agentDir(name: string): string {
  return resolve(voluteHome(), "agents", name);
}

export function nextPort(): number {
  const entries = readRegistry();
  const usedPorts = new Set(entries.map((e) => e.port));
  // Also reserve ports used by variants
  for (const entry of entries) {
    for (const v of readVariants(entry.name)) {
      if (v.port) usedPorts.add(v.port);
    }
  }
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
    const variant = findVariant(baseName, variantName);
    if (!variant) {
      console.error(`Unknown variant: ${variantName} (agent: ${baseName})`);
      process.exit(1);
    }
    return { entry: { ...entry, port: variant.port }, dir: variant.path };
  }

  return { entry, dir };
}
