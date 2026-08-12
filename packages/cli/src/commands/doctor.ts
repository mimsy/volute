import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir, type } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { sharedEnvPath } from "@volute/daemon/lib/config/env.js";
import {
  daemonLogSource,
  getDaemonUrl,
  getServiceMode,
  modeLabel,
  readDaemonConfig,
} from "@volute/daemon/lib/config/service-mode.js";
import { computeSetupStatus, readGlobalConfig } from "@volute/daemon/lib/config/setup.js";
import {
  type BasicMind,
  readMigrationInfo,
  readMindsBasic,
  redactConfigJson,
  redactEnvJson,
  redactLogText,
} from "@volute/daemon/lib/doctor.js";
import { stateDir, voluteHome, voluteSystemDir } from "@volute/daemon/lib/mind/registry.js";
import { exec } from "@volute/daemon/lib/util/exec.js";
import { readLogTail } from "@volute/daemon/lib/util/log-tail.js";
import { command } from "../lib/command.js";
import { getAuthToken } from "../lib/daemon-client.js";

type CheckState = "pass" | "fail" | "warn";
type Check = { label: string; state: CheckState; detail?: string };

const ICON: Record<CheckState, string> = { pass: "✓", fail: "✗", warn: "⚠" };

// --- Chrome/Chromium detection for pages preview ---

const MAC_CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const PATH_CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a Chrome-family browser for `volute pages preview`. Returns the path if
 * found, null otherwise. Mirrors the logic in @volute/pages preview.ts so doctor
 * reports the same result as the actual preview command.
 */
function findChromeBrowser(): string | null {
  const override = process.env.VOLUTE_CHROMIUM;
  if (override) return override;

  if (platform() === "darwin") {
    for (const candidate of MAC_CHROME_CANDIDATES) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  // Linux/other: walk PATH looking for an executable.
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of PATH_CHROME_CANDIDATES) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

function dbPath(): string {
  return process.env.VOLUTE_DB_PATH || resolve(voluteSystemDir(), "volute.db");
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

/** Two-digit-padded local timestamp for the bundle filename: YYYY-MM-DD-HHMMSS. */
function bundleStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * The daemon's local API origin. Built from daemon.json (falling back to defaults)
 * rather than the CLI's resolveDaemonUrl(), which process.exit()s when daemon.json is
 * missing — fatal for a diagnostic that must run on a machine that was never set up.
 */
function daemonBaseUrl(): string {
  const { port, internalPort } = readDaemonConfig();
  return getDaemonUrl("127.0.0.1", internalPort ?? port);
}

/** Best-effort JSON GET against the daemon; null on any failure (daemon down, timeout, auth). */
async function fetchDaemonJson<T>(path: string): Promise<T | null> {
  const base = daemonBaseUrl();
  const headers: Record<string, string> = { Origin: base };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type DaemonMind = {
  name: string;
  running: boolean;
  status?: string;
  parent?: string;
  lastError?: unknown;
};

type Diagnostics = {
  checks: Check[];
  /** Minds as the daemon reports them (authoritative), or null when unreachable. */
  daemonMinds: DaemonMind[] | null;
};

async function runDiagnostics(): Promise<Diagnostics> {
  const checks: Check[] = [];
  const config = readGlobalConfig();

  // --- Daemon reachable ---
  const health = await fetchDaemonJson<{ ok?: boolean; version?: string }>("/api/health");
  const daemonUp = !!health?.ok;
  if (health?.ok) {
    checks.push({
      label: "Daemon reachable",
      state: "pass",
      detail: `${daemonBaseUrl()}${health.version ? ` (v${health.version})` : ""}`,
    });
  } else {
    checks.push({
      label: "Daemon reachable",
      state: "fail",
      detail: `no response at ${daemonBaseUrl()} — start it with \`volute up\``,
    });
  }

  // --- Setup complete + provider configured ---
  const setupState = computeSetupStatus(config);
  const providers = Object.keys(config.ai?.providers ?? {});
  if (setupState === "complete" && providers.length > 0) {
    checks.push({ label: "Setup complete", state: "pass" });
  } else if (setupState === "complete") {
    checks.push({
      label: "Setup complete",
      state: "warn",
      detail: "setup finished but no AI provider is configured",
    });
  } else {
    checks.push({
      label: "Setup complete",
      state: "fail",
      detail:
        setupState === "in-progress" ? "setup started but not finished" : "run `volute setup`",
    });
  }

  // Provider presence — names only, never values/keys.
  checks.push(
    providers.length > 0
      ? { label: "Provider config present", state: "pass", detail: providers.sort().join(", ") }
      : { label: "Provider config present", state: "fail", detail: "no providers configured" },
  );

  // --- Database opens + migration version ---
  const path = dbPath();
  if (!existsSync(path)) {
    checks.push({ label: "Database", state: "warn", detail: "no volute.db yet (fresh install?)" });
  } else {
    const info = await readMigrationInfo(path);
    if (info.ok) {
      checks.push({
        label: "Database",
        state: "pass",
        detail: `opens OK, ${info.applied} migration${info.applied === 1 ? "" : "s"} applied`,
      });
    } else {
      checks.push({ label: "Database", state: "fail", detail: info.error });
    }
  }

  // --- Node / npm versions ---
  checks.push({ label: "Node version", state: "pass", detail: process.version });
  const npmVersion = await exec("npm", ["--version"])
    .then((s) => s.trim())
    .catch(() => null);
  checks.push(
    npmVersion
      ? { label: "npm version", state: "pass", detail: npmVersion }
      : { label: "npm version", state: "warn", detail: "npm not found on PATH" },
  );

  // --- Install type ---
  checks.push({ label: "Install type", state: "pass", detail: modeLabel(getServiceMode()) });

  // --- Isolation mode ---
  const isolation = config.setup?.isolation;
  checks.push(
    isolation
      ? { label: "Isolation mode", state: "pass", detail: isolation }
      : { label: "Isolation mode", state: "warn", detail: "not configured (none)" },
  );

  // --- Chrome for pages preview ---
  const chromePath = findChromeBrowser();
  checks.push(
    chromePath
      ? { label: "Chrome (pages preview)", state: "pass", detail: chromePath }
      : {
          label: "Chrome (pages preview)",
          state: "warn",
          detail: "no Chrome-family browser found — `volute pages preview` won't work",
        },
  );

  // --- Disk space in ~/.volute ---
  try {
    // ~/.volute may not exist yet on a fresh machine; statfs the nearest existing
    // ancestor so the free-space figure is still meaningful.
    const home = voluteHome();
    const st = await statfs(existsSync(home) ? home : homedir());
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    const pctFree = total > 0 ? (free / total) * 100 : 0;
    checks.push({
      label: "Disk space",
      state: pctFree < 5 ? "warn" : "pass",
      detail: `${humanBytes(free)} free of ${humanBytes(total)} (${pctFree.toFixed(0)}%)`,
    });
  } catch (err) {
    checks.push({
      label: "Disk space",
      state: "warn",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Per-mind process status ---
  const daemonMinds = await fetchDaemonJson<DaemonMind[]>("/api/v1/minds");
  if (daemonMinds) {
    if (daemonMinds.length === 0) {
      checks.push({ label: "Minds", state: "pass", detail: "none configured" });
    } else {
      for (const m of daemonMinds) {
        const status = m.status ?? (m.running ? "running" : "stopped");
        const failed = m.lastError ? " (last turn failed)" : "";
        const state: CheckState =
          status === "running" || status === "sleeping" ? "pass" : m.lastError ? "fail" : "warn";
        checks.push({ label: `Mind: ${m.name}`, state, detail: `${status}${failed}` });
      }
    }
  } else {
    // Couldn't get live status — fall back to the registry's last-known running
    // flag. Distinguish a down daemon from one that's up but rejected our request
    // (e.g. the CLI isn't logged in), since the fix differs.
    const why = daemonUp ? "not authenticated — try `volute login`" : "daemon unreachable";
    const rows: BasicMind[] = existsSync(path) ? await readMindsBasic(path) : [];
    if (rows.length === 0) {
      checks.push({ label: "Minds", state: "warn", detail: `${why}; none in registry` });
    } else {
      for (const m of rows) {
        checks.push({
          label: `Mind: ${m.name}`,
          state: "warn",
          detail: `${m.running ? "running?" : "stopped"} (${why} — registry value)`,
        });
      }
    }
  }

  return { checks, daemonMinds };
}

function renderReport(checks: Check[]): string {
  const lines: string[] = ["volute doctor", "═════════════", ""];
  const width = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const detail = c.detail ? `  ${c.detail}` : "";
    lines.push(`${ICON[c.state]} ${c.label.padEnd(width)}${detail}`);
  }
  const failed = checks.filter((c) => c.state === "fail").length;
  const warned = checks.filter((c) => c.state === "warn").length;
  lines.push("");
  lines.push(
    failed === 0 && warned === 0
      ? "All checks passed."
      : `${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}.`,
  );
  return `${lines.join("\n")}\n`;
}

function systemInfo(): string {
  return [
    `date:         ${new Date().toISOString()}`,
    `os:           ${type()} ${release()} (${platform()}/${arch()})`,
    `node:         ${process.version}`,
    `install type: ${modeLabel(getServiceMode())}`,
    `isolation:    ${readGlobalConfig().setup?.isolation ?? "none"}`,
    `volute home:  ${voluteHome()}`,
  ].join("\n");
}

/** Capture `volute status` output for the bundle without exiting the current process. */
async function captureStatus(): Promise<string> {
  const self = process.argv[1];
  try {
    // Replay this process's own loader flags (`process.execArgv`) so the re-invocation
    // works both in the shipped build (`node dist/cli.js`) and in dev, where the entry
    // is a .ts file that needs the tsx loader that launched us.
    return await exec(process.execPath, [...process.execArgv, self, "status"]);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return (
      e.stdout || e.stderr || `(volute status failed: ${err instanceof Error ? err.message : err})`
    );
  }
}

async function writeBundle(report: string, minds: DaemonMind[] | null): Promise<string> {
  const stamp = bundleStamp();
  const stage = mkdtempSync(resolve(tmpdir(), "volute-doctor-"));
  const root = resolve(stage, `volute-doctor-${stamp}`);
  mkdirSync(root, { recursive: true });

  const write = (rel: string, content: string) => {
    const dest = resolve(root, rel);
    mkdirSync(resolve(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  };

  // Diagnostics + system info + `volute status` (scrubbed defensively).
  write("report.txt", report);
  write("system.txt", `${systemInfo()}\n`);
  write("status.txt", redactLogText(await captureStatus()));

  // Redacted config.json (secrets.json is NEVER copied).
  const cfgPath = resolve(voluteSystemDir(), "config.json");
  if (existsSync(cfgPath)) {
    write("config.json", redactConfigJson(readFileSync(cfgPath, "utf-8")));
  }

  // Redacted shared env.json.
  const envPath = sharedEnvPath();
  if (existsSync(envPath)) {
    write("env.json", redactEnvJson(readFileSync(envPath, "utf-8")));
  }

  // Daemon log tail (file-backed modes) or a pointer to the journal. Logs go in
  // verbatim except for credential-shaped substrings, which are scrubbed.
  const src = daemonLogSource(getServiceMode());
  if (src.kind === "file") {
    write("logs/daemon.log", redactLogText(`${readLogTail(src.path, 200).join("\n")}\n`));
  } else {
    const journal = await exec("sh", ["-c", src.command]).catch(
      (err) => `(could not read journal: ${err instanceof Error ? err.message : err})`,
    );
    write("logs/daemon.log", redactLogText(journal));
  }

  // Per-mind: redacted env.json + recent log tail. Prefer the daemon/registry
  // list, but also sweep the centralized state dir directly — a missing or corrupt
  // volute.db is exactly the kind of failure this bundle exists to capture, and the
  // per-mind logs live under state/<name>/ regardless of the DB's health.
  const path = dbPath();
  const listed = minds
    ? minds.map((m) => m.name)
    : existsSync(path)
      ? (await readMindsBasic(path)).map((m) => m.name)
      : [];
  const stateRoot = resolve(voluteSystemDir(), "state");
  const fromState = existsSync(stateRoot)
    ? readdirSync(stateRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const mindNames = [...new Set([...listed, ...fromState])].sort();
  for (const name of mindNames) {
    const mindEnv = resolve(stateDir(name), "env.json");
    if (existsSync(mindEnv)) {
      write(`minds/${name}/env.json`, redactEnvJson(readFileSync(mindEnv, "utf-8")));
    }
    const mindLog = resolve(stateDir(name), "logs", "mind.log");
    const tail = readLogTail(mindLog, 200);
    if (tail.length > 0) write(`minds/${name}/mind.log`, redactLogText(`${tail.join("\n")}\n`));
  }

  const outPath = resolve(process.cwd(), `volute-doctor-${stamp}.tar.gz`);
  try {
    await exec("tar", ["-czf", outPath, "-C", stage, `volute-doctor-${stamp}`]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return outPath;
}

const cmd = command({
  name: "volute doctor",
  description:
    "Diagnose the local Volute install; --bundle writes a sanitized report to attach to a bug report",
  flags: {
    bundle: {
      type: "boolean",
      description: "Write a redacted diagnostic tarball to the current directory",
    },
  },
  examples: ["volute doctor", "volute doctor --bundle"],
  async run({ flags }) {
    const { checks, daemonMinds } = await runDiagnostics();
    const report = renderReport(checks);

    if (!flags.bundle) {
      process.stdout.write(report);
      return;
    }

    process.stdout.write(report);
    const outPath = await writeBundle(report, daemonMinds);
    console.log(`\nBundle written: ${outPath}`);
    console.log("It redacts secrets, but skim it before sharing.");
  },
});

export const run = cmd.execute;
