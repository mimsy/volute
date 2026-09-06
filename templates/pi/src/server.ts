import { resolve } from "node:path";
import { createMind } from "./agent.js";
import { daemonRestart } from "./lib/daemon-client.js";
import { log, setLevel } from "./lib/logger.js";
import { withMechanicsDoc } from "./lib/mechanics-doc.js";
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
if (config.thinkingLevel) log("server", `thinking level: ${config.thinkingLevel}`);

// pi does not auto-load MINDS.md, so the mechanics doc is appended by hand.
const systemPrompt = withMechanicsDoc(loadSystemPrompt(config), resolve("home"));
const pkg = loadPackageInfo();

const mindDir = resolve(".");
const mind = await createMind({
  systemPrompt,
  cwd: resolve("home"),
  mindDir,
  sessionsDir: resolve(".mind/pi-sessions"),
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  maxContextTokens: config.compaction?.maxContextTokens,
  seedTokens: config.continuity?.seedTokens,
  subagents: config.subagents,
  onIdentityReload: async () => {
    log("server", "identity file changed — restarting to reload");
    // No notice: the mind learns about identity-edit restarts from MINDS.md, matching the
    // claude template — the daemon intentionally sends none for a `reload` restart. This
    // turn's commits are already flushed before the event handler drains the watch (claude's
    // server awaits `mind.waitForCommits()` here for the same reason).
    await daemonRestart({ type: "reload" });
  },
});

const router = createRouter({
  configPath: resolve("home/.config/routes.json"),
  mindHandler: mind.resolve,
});

const server = createVoluteServer({
  router,
  port,
  name: pkg.name,
  version: pkg.version,
  getContextInfo: mind.getContextInfo,
  getContextMessages: mind.getContextMessages,
});

server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);
});

setupShutdown();
