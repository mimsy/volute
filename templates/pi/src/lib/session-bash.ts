import {
  createBashToolDefinition,
  defineTool,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * pi's bash tool, with this session's slug bound into every command it spawns.
 *
 * pi runs tools in-process, so every session's commands are children of the one mind
 * process; a process-global `VOLUTE_SESSION` names whichever session wrote it last, and
 * a send from one thread got stamped with a sibling's turn (#1173). Registered as a
 * custom tool named `bash`, this replaces the built-in one for the session it's given to.
 */
export function createSessionBashTool(cwd: string, sessionName: string, settings: SettingsManager) {
  return defineTool(
    createBashToolDefinition(cwd, {
      // What pi's built-in bash would have taken from the same settings.
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
      spawnHook: (ctx) => ({ ...ctx, env: { ...ctx.env, VOLUTE_SESSION: sessionName } }),
    }),
  );
}
