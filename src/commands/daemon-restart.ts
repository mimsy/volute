import { command } from "../lib/command.js";
import {
  getServiceMode,
  modeLabel,
  pollHealth,
  readDaemonConfig,
  restartService,
} from "../lib/service-mode.js";
import { stopDaemon } from "./down.js";
import { run as up } from "./up.js";

const cmd = command({
  name: "volute restart",
  description: "Restart the daemon",
  flags: {
    port: { type: "number", description: "Port to listen on" },
  },
  run: async ({ flags }) => {
    const mode = getServiceMode();

    if (mode !== "manual") {
      console.log(`Restarting volute (${modeLabel(mode)})...`);
      try {
        await restartService(mode);
      } catch (err) {
        console.error(`Failed to restart service: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      const config = readDaemonConfig();
      if (await pollHealth("127.0.0.1", config.internalPort ?? config.port)) {
        console.log("Daemon restarted.");
      } else {
        console.error("Service restarted but daemon did not become healthy within 30s.");
        process.exit(1);
      }
      return;
    }

    // Manual mode: stop then start
    const result = await stopDaemon();
    if (!result.stopped && result.reason === "kill-failed") {
      console.error("Cannot restart: failed to stop the running daemon.");
      process.exit(1);
    }

    const upArgs: string[] = [];
    if (flags.port != null) upArgs.push("--port", String(flags.port));
    await up(upArgs);
  },
});

export const run = cmd.execute;
