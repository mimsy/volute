type FlagDef = { type: "string" } | { type: "number" } | { type: "boolean" };

type FlagValue<T extends FlagDef> = T extends { type: "string" }
  ? string | undefined
  : T extends { type: "number" }
    ? number | undefined
    : boolean;

type FlagValues<T extends Record<string, FlagDef>> = {
  [K in keyof T]: FlagValue<T[K]>;
};

export function parseArgs<T extends Record<string, FlagDef>>(
  args: string[],
  flags: T,
): { positional: string[]; flags: FlagValues<T> } {
  const positional: string[] = [];
  const result = {} as Record<string, unknown>;

  // Initialize defaults
  for (const [key, def] of Object.entries(flags)) {
    result[key] = def.type === "boolean" ? false : undefined;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const def = flags[name];
      if (!def) continue;
      if (def.type === "boolean") {
        result[name] = true;
      } else if (i + 1 < args.length) {
        const val = args[++i];
        result[name] = def.type === "number" ? parseInt(val, 10) : val;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags: result as FlagValues<T> };
}
