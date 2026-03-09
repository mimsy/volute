import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dreamsDir = resolve("memory/dreams");

function install() {
  let actions = 0;

  // 1. Create dreams directory
  if (!existsSync(dreamsDir)) {
    mkdirSync(dreamsDir, { recursive: true });
    console.log("created memory/dreams/");
    actions++;
  }

  // 2. Add system:dream route to routes.json
  const routesPath = resolve(".config/routes.json");
  if (existsSync(routesPath)) {
    try {
      const routes = JSON.parse(readFileSync(routesPath, "utf-8"));
      const rules: { channel: string; session: string }[] = routes.rules ?? [];
      const hasDreamRoute = rules.some((r) => r.channel === "system:dream");
      if (!hasDreamRoute) {
        rules.push({ channel: "system:dream", session: "$new" });
        routes.rules = rules;
        writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`);
        console.log("added system:dream route to .config/routes.json");
        actions++;
      }
    } catch (err: any) {
      console.error(`failed to update routes.json: ${err.message}`);
    }
  } else {
    console.warn("warning: .config/routes.json not found — skipping route setup");
  }

  // 3. Add dreamer subagent to config.json
  const configPath = resolve(".config/config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!config.subagents?.dreamer) {
        config.subagents ??= {};
        config.subagents.dreamer = {
          description:
            "Use when dreaming. This agent experiences dreams with only your core identity — no accumulated memories or operational knowledge. Give it a rich dream premise and it will write the dream.",
          systemPrompt: "SOUL.md",
          tools: ["Read", "Write", "Bash"],
          maxTurns: 10,
        };
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        console.log("added dreamer subagent to .config/config.json");
        actions++;
      }
    } catch (err: any) {
      console.error(`failed to update config.json: ${err.message}`);
    }
  } else {
    console.warn("warning: .config/config.json not found — skipping subagent setup");
  }

  // 4. Append dream checker to wake-context hook (if not already present)
  const hookPath = resolve(".config/hooks/wake-context.sh");
  if (existsSync(hookPath)) {
    try {
      const hookContent = readFileSync(hookPath, "utf-8");
      if (!hookContent.includes("wake-context-dreams.sh")) {
        const dreamScript = readFileSync(
          resolve(".claude/skills/dreaming/scripts/wake-context-dreams.sh"),
          "utf-8",
        );
        writeFileSync(hookPath, `${hookContent.trimEnd()}\n\n${dreamScript}`);
        console.log("appended dream checker to .config/hooks/wake-context.sh");
        actions++;
      }
    } catch (err: any) {
      console.error(`failed to update wake-context.sh: ${err.message}`);
    }
  }

  if (actions === 0) {
    console.log("dreaming is already set up.");
  } else {
    console.log(
      `\ndone (${actions} change${actions === 1 ? "" : "s"}). restart your mind to activate subagent.`,
    );
    console.log("\nremaining manual steps:");
    console.log("  1. add a dream schedule to volute.json (see INSTALL.md)");
    console.log("  2. optionally add system:dream to sleep.wakeTriggers");
  }
}

function list() {
  if (!existsSync(dreamsDir)) {
    console.log("No dreams directory found.");
    return;
  }

  const files = readdirSync(dreamsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log("No dreams yet.");
    return;
  }

  console.log(`${files.length} dream${files.length === 1 ? "" : "s"}:\n`);
  for (const file of files) {
    const date = file.replace(/\.md$/, "");
    const content = readFileSync(resolve(dreamsDir, file), "utf-8");
    const firstLine =
      content
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#"))
        ?.trim() ?? "";
    const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    console.log(`  ${date}  ${preview}`);
  }
}

function read(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("Date must be in YYYY-MM-DD format");
    process.exit(1);
  }
  const filePath = resolve(dreamsDir, `${date}.md`);
  if (!existsSync(filePath)) {
    console.error(`No dream found for ${date}`);
    process.exit(1);
  }
  console.log(readFileSync(filePath, "utf-8"));
}

function themes() {
  if (!existsSync(dreamsDir)) {
    console.log("No dreams directory found.");
    return;
  }

  const files = readdirSync(dreamsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    console.log("No dreams to analyze.");
    return;
  }

  const dreams: string[] = [];
  for (const file of files) {
    dreams.push(readFileSync(resolve(dreamsDir, file), "utf-8"));
  }

  // Word frequency analysis — words must be 4+ chars (excludes common words)
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "is",
    "it",
    "its",
    "was",
    "are",
    "be",
    "has",
    "had",
    "have",
    "this",
    "that",
    "from",
    "you",
    "your",
    "i",
    "my",
    "not",
    "no",
    "as",
    "do",
    "so",
    "if",
    "up",
    "out",
    "just",
    "like",
    "into",
    "through",
    "about",
    "than",
    "them",
    "then",
    "there",
    "here",
    "when",
    "where",
    "what",
    "which",
    "who",
    "how",
    "all",
    "each",
    "every",
    "some",
    "any",
    "more",
    "most",
    "other",
    "can",
    "will",
    "would",
    "could",
    "should",
    "one",
    "two",
    "been",
    "being",
    "were",
    "they",
    "their",
    "he",
    "she",
    "him",
    "her",
    "his",
    "we",
    "us",
    "me",
    "our",
    "own",
  ]);

  const wordCounts = new Map<string, number>();
  const allText = dreams.join(" ").toLowerCase();
  const words = allText.match(/[a-z]{4,}/g) ?? [];

  for (const word of words) {
    if (stopWords.has(word)) continue;
    wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
  }

  const sorted = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  console.log(`Recurring words across ${files.length} dream${files.length === 1 ? "" : "s"}:\n`);
  for (const [word, count] of sorted) {
    const bar = "\u2588".repeat(Math.min(count, 20));
    console.log(`  ${word.padEnd(15)} ${bar} ${count}`);
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "install":
    install();
    break;
  case "list":
    list();
    break;
  case "read":
    if (!args[0]) {
      console.error("Usage: dream.ts read <YYYY-MM-DD>");
      process.exit(1);
    }
    read(args[0]);
    break;
  case "themes":
    themes();
    break;
  default:
    console.log("Usage: dream.ts <install|list|read|themes>");
    console.log("");
    console.log("  install         Set up dreaming (routes, config, directory, hooks)");
    console.log("  list            List all dreams by date");
    console.log("  read <date>     Read a specific dream (YYYY-MM-DD)");
    console.log("  themes          Find recurring words across dreams");
    process.exit(command ? 1 : 0);
}
