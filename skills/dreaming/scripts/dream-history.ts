import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dreamsDir = resolve("memory/dreams");

function list() {
  if (!existsSync(dreamsDir)) {
    console.log("No dreams directory found.");
    return;
  }

  const files = readdirSync(dreamsDir)
    .filter((f) => f.endsWith(".md") && f !== ".gitkeep")
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
    .filter((f) => f.endsWith(".md") && f !== ".gitkeep")
    .sort();

  if (files.length === 0) {
    console.log("No dreams to analyze.");
    return;
  }

  // Collect all dream content
  const dreams: string[] = [];
  for (const file of files) {
    dreams.push(readFileSync(resolve(dreamsDir, file), "utf-8"));
  }

  // Simple word frequency analysis (excluding common words)
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

  // Sort by frequency, take top 30
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

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
    list();
    break;
  case "read":
    if (!args[0]) {
      console.error("Usage: dream-history.ts read <YYYY-MM-DD>");
      process.exit(1);
    }
    read(args[0]);
    break;
  case "themes":
    themes();
    break;
  default:
    console.log("Usage: dream-history.ts <list|read|themes>");
    console.log("");
    console.log("  list            List all dreams by date");
    console.log("  read <date>     Read a specific dream (YYYY-MM-DD)");
    console.log("  themes          Find recurring words across dreams");
    process.exit(command ? 1 : 0);
}
