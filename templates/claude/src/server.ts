import { resolve } from "node:path";
import { createMind } from "./agent.js";
import { log, setLevel } from "./lib/logger.js";
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
if (config.thinking) log("server", `thinking: ${JSON.stringify(config.thinking)}`);
if (config.effort) log("server", `effort: ${config.effort}`);

const sessionsDir = resolve(".mind/sessions");

const pkg = loadPackageInfo();
const abortController = new AbortController();
const mind = createMind({
  loadSystemPrompt: () => loadSystemPrompt(config),
  cwd: resolve("home"),
  abortController,
  model: config.model,
  thinking: config.thinking,
  effort: config.effort,
  sessionsDir,
  maxContextTokens: config.compaction?.maxContextTokens,
  sessionIdleMinutes: config.sessionIdleMinutes,
  seedTokens: config.continuity?.seedTokens,
  coldResetMinutes: config.memory?.recollection?.coldResetMinutes,
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

// Reap live SDK subprocesses on SIGTERM/SIGINT so `mind stop`/restart don't
// orphan `<defunct>` claude children to PID 1 (the daemon, which isn't a
// reaping init). Bounded so a wedged child can't block shutdown forever.
// Stop accepting new messages first so a late request can't spawn a fresh
// subprocess after reapAllSessions has snapshotted the live set (which would
// re-orphan the very child we're reaping).
setupShutdown(async () => {
  server.close();
  // Commit edits from a turn the shutdown cut short — e.g. the mind ran `volute mind
  // restart` mid-turn to load an identity edit; that turn never reaches its own flush.
  // Alongside the reap, so a wedged git can't hold the children past the shutdown bound.
  await Promise.all([
    mind.flushFileChanges().catch((err) => log("server", "shutdown commit failed:", err)),
    mind.reapAllSessions(),
  ]);
});
