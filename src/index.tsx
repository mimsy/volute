#!/usr/bin/env bun
import { render } from "ink";
import { readFileSync } from "fs";
import { resolve } from "path";
import { App } from "./App.js";

function getSoulPath(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--soul" && args[i + 1]) {
      return args[i + 1];
    }
    if (!args[i].startsWith("-")) {
      return args[i];
    }
  }
  return "SOUL.md";
}

const soulPath = resolve(getSoulPath());

function loadSoul(): string {
  try {
    return readFileSync(soulPath, "utf-8");
  } catch {
    console.error(`Could not read soul file: ${soulPath}`);
    process.exit(1);
  }
}

const systemPrompt = loadSoul();
render(<App systemPrompt={systemPrompt} />);
