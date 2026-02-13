import { resolve } from "node:path";
import { createAgent } from "./agent.js";
import { createFileHandlerResolver } from "./lib/file-handler.js";
import { log } from "./lib/logger.js";
import { createRouter } from "./lib/router.js";
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
if (config.thinkingLevel) log("server", `thinking level: ${config.thinkingLevel}`);

const systemPrompt = loadSystemPrompt();
const pkg = loadPackageInfo();

const agent = createAgent({
  systemPrompt,
  cwd: resolve("home"),
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  compactionMessage: config.compactionMessage,
});

const router = createRouter({
  configPath: resolve("home/.config/routes.json"),
  agentHandler: agent.resolve,
  fileHandler: createFileHandlerResolver(resolve("home")),
});

const server = createVoluteServer({
  router,
  port,
  name: pkg.name,
  version: pkg.version,
});

server.listen(port, async () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
  const hasMerge = handleMergeContext((content) =>
    router.route([{ type: "text", text: content }], { channel: "system" }),
  );
  if (!hasMerge) {
    await handleStartupContext((content) =>
      router.route([{ type: "text", text: content }], { channel: "system" }),
    );
  }
});

setupShutdown();
