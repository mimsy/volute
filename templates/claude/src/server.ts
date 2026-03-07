import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createMind } from "./agent.js";
import { daemonRestart } from "./lib/daemon-client.js";
import { createFileHandlerResolver } from "./lib/file-handler.js";
import { log, setLevel } from "./lib/logger.js";
import { createRouter } from "./lib/router.js";
import {
  loadConfig,
  loadPackageInfo,
  loadSystemPrompt,
  parseArgs,
  setupShutdown,
} from "./lib/startup.js";
import { createVoluteServer } from "./lib/volute-server.js";

const { port } = parseArgs();
const config = loadConfig();
if (config.logLevel) setLevel(config.logLevel);
if (config.model) log("server", `using model: ${config.model}`);
if (config.maxThinkingTokens) log("server", `max thinking tokens: ${config.maxThinkingTokens}`);

const systemPrompt = loadSystemPrompt();
const sessionsDir = resolve(".mind/sessions");

// Migrate old single session.json → sessions/main.json
const oldSessionPath = resolve(".mind/session.json");
if (existsSync(oldSessionPath) && !existsSync(resolve(sessionsDir, "main.json"))) {
  mkdirSync(sessionsDir, { recursive: true });
  renameSync(oldSessionPath, resolve(sessionsDir, "main.json"));
  log("server", "migrated session.json → sessions/main.json");
}

const pkg = loadPackageInfo();
const abortController = new AbortController();
const mind = createMind({
  systemPrompt,
  cwd: resolve("home"),
  abortController,
  model: config.model,
  maxThinkingTokens: config.maxThinkingTokens,
  sessionsDir,
  compactionMessage: config.compactionMessage,
  maxContextTokens: config.compaction?.maxContextTokens,
  onIdentityReload: async () => {
    log("server", "identity file changed — restarting to reload");
    await mind.waitForCommits();
    await daemonRestart({ type: "reload" });
  },
});

const router = createRouter({
  configPath: resolve("home/.config/routes.json"),
  mindHandler: mind.resolve,
  fileHandler: createFileHandlerResolver(resolve("home")),
});

const server = createVoluteServer({
  router,
  port,
  name: pkg.name,
  version: pkg.version,
});

server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
});

setupShutdown();
