import type { FlagDef } from "./parse-args.js";

/**
 * Pull the extension layer's global `--mind <name>` out of a subcommand's argv.
 *
 * `--mind` is documented in every extension's group help as the act-as identity selector,
 * and the daemon reads it from the request body rather than from the parsed flags. So it
 * has to be lifted out before the subcommand's own strict flag validation runs, or a
 * documented flag would be reported as unknown.
 *
 * The one exception is a subcommand that declares a `mind` flag of its own (the intentions
 * extension's `list --mind <name>`, "show another mind's active intentions"). Hoisting
 * that would make the declared flag permanently unreachable — advertised in `--help` and
 * impossible to use. When the subcommand declares it, it stays in argv and the handler
 * decides what it means.
 *
 * Returns the requested identity plus the remaining argv, or an `error` to print.
 */
export function extractMindFlag(
  argv: string[],
  flagDefs: Record<string, FlagDef> | undefined,
): { mind: string | undefined; rest: string[] } | { error: string } {
  const envMind = process.env.VOLUTE_MIND;
  if (flagDefs && "mind" in flagDefs) return { mind: envMind, rest: argv };

  const idx = argv.findIndex((a) => a === "--mind" || a.startsWith("--mind="));
  if (idx === -1) return { mind: envMind, rest: argv };

  const token = argv[idx];
  const inline = token.startsWith("--mind=") ? token.slice("--mind=".length) : undefined;
  const value = inline ?? argv[idx + 1];
  // A trailing `--mind` used to sit in argv doing nothing. Under strict parsing it would
  // surface as "unknown option: --mind", which is a lie about a documented flag.
  if (!value) return { error: "error: --mind requires a value" };

  const rest = [...argv];
  rest.splice(idx, inline === undefined ? 2 : 1);
  return { mind: value, rest };
}
