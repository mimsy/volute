import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { voluteHome } from "../lib/registry.js";
import { stopDaemon } from "./down.js";
import { run as up } from "./up.js";

export async function run(args: string[]) {
  const result = await stopDaemon();

  if (!result.stopped && result.reason === "systemd") {
    const client = getClient();
    await daemonFetch(urlOf(client.api.system.restart.$url()), { method: "POST" });

    // Build base URL from daemon.json for health polling.
    // Use raw fetch since daemonFetch exits on ECONNREFUSED,
    // which is expected while the daemon restarts.
    const config = JSON.parse(readFileSync(resolve(voluteHome(), "daemon.json"), "utf-8"));
    let hostname = config.hostname || "localhost";
    if (hostname === "0.0.0.0") hostname = "127.0.0.1";
    if (hostname === "::") hostname = "[::1]";
    const url = new URL("http://localhost");
    url.hostname = hostname;
    url.port = String(config.port ?? 4200);
    const healthUrl = `${url.origin}/api/health`;

    const maxWait = 15_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          console.log("Daemon restarted.");
          return;
        }
      } catch {
        // Not ready yet (ECONNREFUSED expected during restart)
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    console.error("Daemon did not restart within 15s. Check logs.");
    process.exit(1);
  }

  if (!result.stopped && result.reason === "kill-failed") {
    console.error("Cannot restart: failed to stop the running daemon.");
    process.exit(1);
  }

  await up(args);
}
