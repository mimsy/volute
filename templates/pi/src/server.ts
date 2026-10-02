import { resolve } from "node:path";
import { createMind } from "./agent.js";
import { flushFileChanges, waitForCommits } from "./lib/auto-commit.js";
import { log, setLevel } from "./lib/logger.js";
import { withMechanicsDoc } from "./lib/mechanics-doc.js";
import { createRouter } from "./lib/router.js";
import {
  loadConfig,
  loadPackageInfo,
  loadSystemPrompt,
  parseArgs,
  setPrivateUmask,
  setupShutdown,
} from "./lib/startup.js";
import { createVoluteServer } from "./lib/volute-server.js";

setPrivateUmask();
const { port } = parseArgs();
const config = loadConfig();
if (config.logLevel) setLevel(config.logLevel);
if (config.model) log("server", `using model: ${config.model}`);
if (config.thinkingLevel) log("server", `thinking level: ${config.thinkingLevel}`);

const pkg = loadPackageInfo();

const mindDir = resolve(".");
const mind = await createMind({
  // pi does not auto-load MINDS.md, so the mechanics doc is appended by hand. Rebuilt at
  // each session boundary, so an identity edit loads there without a restart.
  loadSystemPrompt: () => withMechanicsDoc(loadSystemPrompt(config), resolve("home")),
  cwd: resolve("home"),
  mindDir,
  sessionsDir: resolve(".mind/pi-sessions"),
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  maxContextTokens: config.compaction?.maxContextTokens,
  seedTokens: config.continuity?.seedTokens,
  recollection: config.memory?.recollection?.enabled !== false,
  subagents: config.subagents,
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

// Commit edits from a turn the shutdown cut short — e.g. the mind ran `volute mind
// restart` mid-turn; that turn never reaches its own flush. Wait out an in-flight turn-end
// commit first: the stop's signal can kill its git, and a killed commit re-queues its files
// for this flush to retry (#1206). Stop accepting messages first.
setupShutdown(async () => {
  server.close();
  await waitForCommits()
    .then(() => flushFileChanges(resolve("home")))
    .catch((err) => log("server", "shutdown commit failed:", err));
});
