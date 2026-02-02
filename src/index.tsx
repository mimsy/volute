#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./App.js";

function getPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      return parseInt(args[i + 1], 10);
    }
  }
  return 4100;
}

const port = getPort();
const serverUrl = `http://localhost:${port}`;

render(<App serverUrl={serverUrl} />);
