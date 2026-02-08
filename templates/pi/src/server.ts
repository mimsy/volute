import { resolve } from "node:path";
import { createAgent } from "./agent.js";
import { log } from "./lib/logger.js";
import {
  handleMergeContext,
  handleStartupContext,
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
const pkg = loadPackageInfo();

const agent = createAgent({
  systemPrompt,
  cwd: resolve("home"),
  model: config.model,
  compactionMessage: config.compactionMessage,
});

const server = createVoluteServer({
  agent,
  port,
  name: pkg.name,
  version: pkg.version,
  sessionsConfigPath: resolve("home/.config/sessions.json"),
});

server.listen(port, async () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
  const hasMerge = handleMergeContext((content) => agent.sendMessage(content));
  if (!hasMerge) {
    await handleStartupContext((content) => agent.sendMessage(content));
  }
});

setupShutdown();
