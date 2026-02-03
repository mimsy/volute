import { render } from "ink";
import React from "react";
import { App } from "../components/App.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
  });

  const port = flags.port ?? 4100;
  const serverUrl = `http://localhost:${port}`;
  render(<App serverUrl={serverUrl} />);
}
