import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAgent } from "./agent.js";
import { createFileHandlerResolver } from "./lib/file-handler.js";
import { log } from "./lib/logger.js";
import { createRouter } from "./lib/router.js";
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
  compactionMessage: config.compactionMessage,
  onIdentityReload: async () => {
    log("server", "identity file changed — restarting to reload");
    await agent.waitForCommits();
    // Signal daemon to restart immediately (bypasses crash backoff)
    try {
      writeFileSync(resolve(".volute/restart.json"), JSON.stringify({ action: "reload" }));
    } catch (err) {
      log("server", "failed to write restart signal:", err);
    }
    server.close();
    process.exit(0);
  },
});

const router = createRouter({
  configPath: resolve("home/.config/sessions.json"),
  agentHandler: agent.resolve,
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
  handleMergeContext((content) =>
    router.route([{ type: "text", text: content }], { channel: "system" }),
  );
});

setupShutdown();
