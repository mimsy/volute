export type FlagDef = { type: "string" } | { type: "number" } | { type: "boolean" };

type FlagValue<T extends FlagDef> = T extends { type: "string" }
  ? string | undefined
  : T extends { type: "number" }
    ? number | undefined
    : boolean;

type FlagValues<T extends Record<string, FlagDef>> = {
  [K in keyof T]: FlagValue<T[K]>;
};

/** Positional slots a command declares, in order. Only names and requiredness are used here. */
export type PositionalDef = { name: string; required?: boolean };

/**
 * Refuse the invocation, naming the offending token.
 *
 * Everything in this module fails loud rather than dropping what it does not understand.
 * A silently-ignored flag leaves no artifact: the command still runs, still exits 0, and
 * still prints real output — just the answer to a question nobody asked. Three minds
 * independently invented `volute pages list --mind <name>`, each got the caller's own
 * list back, and each read that as a finding about the interface (#907). Refusal is the
 * information.
 */
function refuse(message: string, hint?: string): never {
  console.error(`error: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
  // process.exit is typed `never`, but tests stub it; make the contract explicit.
  throw new Error(message);
}

/** "known options: --all, --shared" — the flags this command actually accepts. */
function knownFlagList(flags: Record<string, FlagDef>): string {
  const names = Object.keys(flags);
  if (names.length === 0) return "this command takes no options";
  return `known options: ${names.map((n) => `--${n}`).join(", ")}`;
}

/**
 * Reject positionals beyond the ones a command declares.
 *
 * Shared by `command()` and by the extension-command dispatch in `src/cli.ts`, which
 * validates against the arg/flag metadata the daemon serves over
 * `/api/v1/extensions/commands`. `volute pages list gardener` used to drop `gardener`
 * and print the caller's own list.
 */
export function enforceArity(positional: string[], argDefs: PositionalDef[] = []): void {
  if (positional.length <= argDefs.length) return;
  const extra = positional[argDefs.length];
  refuse(
    `unknown argument: ${extra}`,
    argDefs.length === 0
      ? "this command takes no arguments"
      : `takes at most ${argDefs.length} argument${argDefs.length === 1 ? "" : "s"}: ${argDefs
          .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
          .join(" ")}`,
  );
}

export function parseArgs<T extends Record<string, FlagDef>>(
  args: string[],
  flags: T,
): { positional: string[]; flags: FlagValues<T>; help: boolean } {
  const positional: string[] = [];
  const result = {} as Record<string, unknown>;
  let help = false;

  // Initialize defaults
  for (const [key, def] of Object.entries(flags)) {
    result[key] = def.type === "boolean" ? false : undefined;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      // `--flag=value` is the other spelling every CLI accepts. Without it, strictness
      // would report a documented flag as unknown — a worse lie than the old silence.
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const def = flags[name];
      if (!def) refuse(`unknown option: --${name}`, knownFlagList(flags));
      if (def.type === "boolean") {
        if (inlineValue !== undefined) {
          refuse(`--${name} is a flag and takes no value (got --${name}=${inlineValue})`);
        }
        result[name] = true;
        continue;
      }
      // A trailing value-taking flag has nothing to consume. Leaving it undefined is
      // the same silence this module exists to remove.
      if (inlineValue === undefined && i + 1 >= args.length) {
        refuse(`--${name} requires a value`);
      }
      const val = inlineValue ?? args[++i];
      if (def.type === "number") {
        // Deliberately not parseInt: it salvages a leading numeric prefix, so
        // `--before 2026-08-12` becomes 2026 — a plausible-looking message id that
        // serves the wrong page with a 200 (#868; two minds guessed timestamp for
        // `chat read --before`). Anything that is not exactly digits is refused.
        if (!/^-?\d+$/.test(val)) refuse(`--${name} expects a number, got: ${val}`);
        result[name] = Number(val);
      } else {
        result[name] = val;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags: result as FlagValues<T>, help };
}
