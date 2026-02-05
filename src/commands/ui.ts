import { parseArgs } from "../lib/parse-args.js";
import { startServer } from "../web/server.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
  });

  const port = flags.port ?? 4200;
  startServer({ port });
}
