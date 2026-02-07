import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createAgent } from "./agent.js";
import { log } from "./lib/logger.js";
import {
  handleMergeContext,
  loadConfig,
  loadPackageInfo,
  loadSystemPrompt,
  parseArgs,
  setupShutdown,
} from "./lib/startup.js";
import { createVoluteServer } from "./lib/volute-server.js";

const { port } = parseArgs();
const config = loadConfig();
if (config.model) log("server", `using model: ${config.model}`);

const systemPrompt = loadSystemPrompt();
const sessionsDir = resolve(".volute/sessions");

// Migrate old single session.json → sessions/main.json
const oldSessionPath = resolve(".volute/session.json");
if (existsSync(oldSessionPath) && !existsSync(resolve(sessionsDir, "main.json"))) {
  mkdirSync(sessionsDir, { recursive: true });
  renameSync(oldSessionPath, resolve(sessionsDir, "main.json"));
  log("server", "migrated session.json → sessions/main.json");
}

const pkg = loadPackageInfo();
const abortController = new AbortController();
const agent = createAgent({
  systemPrompt,
  cwd: resolve("home"),
  abortController,
  model: config.model,
  sessionsDir,
  onIdentityReload: async () => {
    log("server", "identity file changed — restarting to reload");
    await agent.waitForCommits();
    server.close();
    process.exit(0);
  },
});

const server = createVoluteServer({
  agent,
  port,
  name: pkg.name,
  version: pkg.version,
  sessionsConfigPath: resolve("home/.config/sessions.json"),
});

server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
  handleMergeContext((content) => agent.sendMessage(content));
});

setupShutdown();
