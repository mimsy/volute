import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findVariant, readVariants } from "./variants.js";

export function voluteHome(): string {
  if (process.env.VOLUTE_HOME) return process.env.VOLUTE_HOME;

  // When running from source (tsx), require explicit VOLUTE_HOME to prevent
  // tests from accidentally touching the real ~/.volute directory.
  // Built code (dist/) falls through to the homedir() default.
  const dir = dirname(fileURLToPath(import.meta.url));
  if (dir.endsWith("/src/lib")) {
    throw new Error(
      "VOLUTE_HOME must be set when running from source. " +
        'For tests, run via "npm test" or add "--import ./test/setup.ts".',
    );
  }

  return resolve(homedir(), ".volute");
}

export type AgentEntry = {
  name: string;
  port: number;
  created: string;
  running: boolean;
};

export function ensureVoluteHome() {
  const agentsBase = process.env.VOLUTE_AGENTS_DIR ?? resolve(voluteHome(), "agents");
  mkdirSync(agentsBase, { recursive: true });
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
  const tmpPath = `${registryPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmpPath, registryPath);
}

const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const AGENT_NAME_MAX = 64;

export function validateAgentName(name: string): string | null {
  if (!name) return "Agent name is required";
  if (name.length > AGENT_NAME_MAX)
    return `Agent name must be at most ${AGENT_NAME_MAX} characters`;
  if (!AGENT_NAME_RE.test(name)) {
    return "Agent name must start with alphanumeric and contain only alphanumeric, dots, dashes, or underscores";
  }
  return null;
}

export function addAgent(name: string, port: number) {
  const err = validateAgentName(name);
  if (err) throw new Error(err);
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
  if (process.env.VOLUTE_AGENTS_DIR) {
    return resolve(process.env.VOLUTE_AGENTS_DIR, name);
  }
  return resolve(voluteHome(), "agents", name);
}

export function stateDir(name: string): string {
  return resolve(voluteHome(), "state", name);
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
  if (port > 65535) throw new Error("No available ports — all ports 4100-65535 are allocated");
  return port;
}

/** Map a server bind hostname to the appropriate loopback for internal connections. */
export function daemonLoopback(): string {
  const host = process.env.VOLUTE_DAEMON_HOSTNAME || "127.0.0.1";
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host;
}

export function resolveAgent(name: string): { entry: AgentEntry; dir: string } {
  // Parse name@variant syntax
  const [baseName, variantName] = name.split("@", 2);

  const entry = findAgent(baseName);
  if (!entry) {
    throw new Error(`Unknown agent: ${baseName}`);
  }
  const dir = agentDir(baseName);
  if (!existsSync(dir)) {
    throw new Error(`Agent directory missing: ${dir}`);
  }

  if (variantName) {
    const variant = findVariant(baseName, variantName);
    if (!variant) {
      throw new Error(`Unknown variant: ${variantName} (agent: ${baseName})`);
    }
    return { entry: { ...entry, port: variant.port }, dir: variant.path };
  }

  return { entry, dir };
}
