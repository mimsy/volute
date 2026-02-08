import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./logger.js";

export function parseArgs(): { port: number } {
  const args = process.argv.slice(2);
  let port = 4100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }

  return { port };
}

export function loadConfig(): { model?: string; compactionMessage?: string } {
  try {
    return JSON.parse(readFileSync(resolve("home/.config/volute.json"), "utf-8"));
  } catch {
    return {};
  }
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function loadSystemPrompt(): string {
  const soulPath = resolve("home/SOUL.md");
  const memoryPath = resolve("home/MEMORY.md");
  const volutePath = resolve("home/VOLUTE.md");

  const soul = loadFile(soulPath);
  if (!soul) {
    console.error(`Could not read soul file: ${soulPath}`);
    process.exit(1);
  }

  const memory = loadFile(memoryPath);
  const volute = loadFile(volutePath);

  const promptParts = [soul];
  if (volute) promptParts.push(volute);
  if (memory) promptParts.push(`## Memory\n\n${memory}`);
  return promptParts.join("\n\n---\n\n");
}

export function loadPackageInfo(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
    return { name: pkg.name || "unknown", version: pkg.version || "0.0.0" };
  } catch {
    return { name: "unknown", version: "0.0.0" };
  }
}

export function handleMergeContext(sendMessage: (content: string) => void): boolean {
  const mergedPath = resolve(".volute/merged.json");
  if (!existsSync(mergedPath)) return false;

  try {
    const merged = JSON.parse(readFileSync(mergedPath, "utf-8"));
    unlinkSync(mergedPath);

    const parts = [
      `[system] Variant "${merged.name}" has been merged and you have been restarted.`,
    ];
    if (merged.summary) parts.push(`Changes: ${merged.summary}`);
    if (merged.justification) parts.push(`Why: ${merged.justification}`);
    if (merged.memory) parts.push(`Context: ${merged.memory}`);

    sendMessage(parts.join("\n"));
    log("server", `sent post-merge orientation for variant: ${merged.name}`);
    return true;
  } catch (e) {
    log("server", "failed to process merged.json:", e);
    return false;
  }
}

export async function handleStartupContext(sendMessage: (content: string) => void): Promise<void> {
  const scriptPath = resolve("home/.config/hooks/startup-context.sh");
  if (!existsSync(scriptPath)) return;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("bash", [scriptPath], { timeout: 5000 });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stdin.end(JSON.stringify({ source: "startup" }));
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`exit code ${code}`)),
      );
      child.on("error", reject);
    });

    // Try to parse as JSON hook output
    let context: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      context = parsed?.hookSpecificOutput?.additionalContext ?? null;
    } catch {
      // Fall back to plain text
      context = stdout.trim();
    }

    if (context) {
      sendMessage(`[system] ${context}`);
      log("server", "sent startup context");
    }
  } catch (e) {
    log("server", "failed to run startup-context.sh:", e);
  }
}

export function setupShutdown(): void {
  function shutdown() {
    log("server", "shutdown signal received");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
