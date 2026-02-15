import { stopDaemon } from "./down.js";
import { run as up } from "./up.js";

export async function run(args: string[]) {
  const result = await stopDaemon();

  if (!result.stopped && result.reason === "systemd") {
    console.error("Volute is managed by a systemd service.");
    console.error("Use: sudo systemctl restart volute");
    process.exit(1);
  }

  if (!result.stopped && result.reason === "kill-failed") {
    console.error("Cannot restart: failed to stop the running daemon.");
    process.exit(1);
  }

  await up(args);
}
