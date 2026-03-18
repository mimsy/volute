import { resolve } from "node:path";
import { createMind } from "./agent.js";
import { createFileHandlerResolver } from "./lib/file-handler.js";
import { log, setLevel } from "./lib/logger.js";
import { createRouter } from "./lib/router.js";
import {
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
if (config.logLevel) setLevel(config.logLevel);
if (config.model) log("server", `using model: ${config.model}`);
if (config.reasoningEffort) log("server", `reasoning effort: ${config.reasoningEffort}`);

const systemPrompt = loadSystemPrompt();
const pkg = loadPackageInfo();

const mindDir = resolve(".");
const cwd = resolve("home");

const mind = createMind({
  systemPrompt,
  cwd,
  mindDir,
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  maxContextTokens: config.compaction?.maxContextTokens,
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

server.listen(port, async () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
  await handleStartupContext((content) =>
    router.route([{ type: "text", text: content }], { channel: "system" }),
  );
});

setupShutdown();
