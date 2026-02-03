import { render } from "ink";
import React from "react";
import { App } from "../components/App.js";

export async function run(args: string[]) {
  let port = 4100;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
    }
  }

  const serverUrl = `http://localhost:${port}`;
  render(<App serverUrl={serverUrl} />);
}
