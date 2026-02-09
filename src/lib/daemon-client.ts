import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

type DaemonConfig = { port: number; hostname?: string; token?: string };

function readDaemonConfig(): DaemonConfig {
  const configPath = resolve(voluteHome(), "daemon.json");
  if (!existsSync(configPath)) {
    console.error("Volute is not running. Start with: volute up");
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    console.error("Volute is not running. Start with: volute up");
    process.exit(1);
  }
}

export function getDaemonUrl(): string {
  const config = readDaemonConfig();
  return `http://${config.hostname || "localhost"}:${config.port}`;
}

export async function daemonFetch(path: string, options?: RequestInit): Promise<Response> {
  const config = readDaemonConfig();
  const url = `http://${config.hostname || "localhost"}:${config.port}`;
  const headers = new Headers(options?.headers);

  // Include internal auth token for CLI-to-daemon requests
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }

  // Set origin to pass CSRF checks on mutation requests
  headers.set("Origin", url);

  try {
    return await fetch(`${url}${path}`, { ...options, headers });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as TypeError & { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
    ) {
      console.error("Volute is not running. Start with: volute up");
      process.exit(1);
    }
    throw err;
  }
}
