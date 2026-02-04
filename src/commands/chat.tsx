import { render } from "ink";
import React from "react";
import { App } from "../components/App.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: molt chat <name>");
    process.exit(1);
  }

  const { entry } = resolveAgent(name);
  const serverUrl = `http://localhost:${entry.port}`;
  render(<App serverUrl={serverUrl} />);
}
