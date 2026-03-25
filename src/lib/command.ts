import { type FlagDef as BaseFlagDef, parseArgs } from "./parse-args.js";

type FlagDef = BaseFlagDef & { description: string };

type FlagValue<T extends FlagDef> = T extends { type: "string" }
  ? string | undefined
  : T extends { type: "number" }
    ? number | undefined
    : boolean;

type FlagValues<T extends Record<string, FlagDef>> = {
  [K in keyof T]: FlagValue<T[K]>;
};

type ArgDef = {
  name: string;
  required?: boolean;
  description: string;
};

type CommandDef<F extends Record<string, FlagDef>> = {
  name: string;
  description: string;
  args?: ArgDef[];
  flags: F;
  examples?: string[];
  run: (parsed: {
    args: Record<string, string | undefined>;
    flags: FlagValues<F>;
    rest: string[];
  }) => Promise<void>;
};

export type Command = {
  execute: (argv: string[]) => Promise<void>;
  printHelp: () => void;
};

export function command<F extends Record<string, FlagDef>>(def: CommandDef<F>): Command {
  function printHelp() {
    const argParts = (def.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`));
    const hasFlags = Object.keys(def.flags).length > 0;
    const flagPart = hasFlags ? " [options]" : "";
    const argStr = argParts.length > 0 ? ` ${argParts.join(" ")}` : "";

    console.log(`${def.description}\n`);
    console.log(`Usage: ${def.name}${argStr}${flagPart}\n`);

    if (def.args && def.args.length > 0) {
      console.log("Arguments:");
      const nameWidth = Math.max(...def.args.map((a) => a.name.length + 2));
      for (const a of def.args) {
        const label = a.required ? `<${a.name}>` : `[${a.name}]`;
        console.log(`  ${label.padEnd(nameWidth + 2)}  ${a.description}`);
      }
      console.log("");
    }

    if (hasFlags) {
      console.log("Options:");
      const entries = Object.entries(def.flags);
      const nameWidth = Math.max(
        ...entries.map(([k, v]) => {
          const valueHint = v.type === "boolean" ? "" : ` <${v.type === "string" ? "value" : "n"}>`;
          return `--${k}${valueHint}`.length;
        }),
      );
      for (const [key, val] of entries) {
        const valueHint =
          val.type === "boolean" ? "" : ` <${val.type === "string" ? "value" : "n"}>`;
        const flag = `--${key}${valueHint}`;
        console.log(`  ${flag.padEnd(nameWidth + 2)}  ${val.description}`);
      }
      console.log("");
    }

    if (def.examples && def.examples.length > 0) {
      console.log("Examples:");
      for (const ex of def.examples) {
        console.log(`  ${ex}`);
      }
      console.log("");
    }
  }

  async function execute(argv: string[]) {
    const parseFlags = {} as Record<string, { type: "string" | "number" | "boolean" }>;
    for (const [key, val] of Object.entries(def.flags)) {
      parseFlags[key] = { type: val.type };
    }

    const { positional, flags, help } = parseArgs(argv, parseFlags);

    if (help) {
      printHelp();
      process.exit(0);
    }

    const namedArgs: Record<string, string | undefined> = {};
    const argDefs = def.args ?? [];
    for (let i = 0; i < argDefs.length; i++) {
      namedArgs[argDefs[i].name] = positional[i];
    }

    for (const argDef of argDefs) {
      if (argDef.required && !namedArgs[argDef.name]) {
        console.error(`Missing required argument: <${argDef.name}>`);
        printHelp();
        process.exit(1);
      }
    }

    const rest = positional.slice(argDefs.length);

    await def.run({ args: namedArgs, flags: flags as FlagValues<F>, rest });
  }

  return { execute, printHelp };
}

// --- subcommands() ---

type SubcommandEntry = {
  description: string;
  run: (args: string[]) => Promise<void>;
};

type SubcommandsDef = {
  name: string;
  description: string;
  commands: Record<string, SubcommandEntry>;
  footer?: string;
};

export type SubcommandGroup = {
  execute: (argv: string[]) => Promise<void>;
  printHelp: () => void;
};

export function subcommands(def: SubcommandsDef): SubcommandGroup {
  function printHelp() {
    console.log(`${def.description}\n`);
    console.log(`Usage: ${def.name} <command> [options]\n`);
    console.log("Commands:");
    const entries = Object.entries(def.commands);
    const nameWidth = Math.max(...entries.map(([k]) => k.length));
    for (const [name, sub] of entries) {
      console.log(`  ${name.padEnd(nameWidth + 2)}  ${sub.description}`);
    }
    if (def.footer) {
      console.log(`\n${def.footer}`);
    }
    console.log("");
  }

  async function execute(argv: string[]) {
    const sub = argv[0];

    if (!sub || sub === "--help" || sub === "-h") {
      printHelp();
      if (!sub) process.exit(1);
      process.exit(0);
    }

    const entry = def.commands[sub];
    if (!entry) {
      console.error(`Unknown command: ${def.name} ${sub}`);
      printHelp();
      process.exit(1);
    }

    await entry.run(argv.slice(1));
  }

  return { execute, printHelp };
}
