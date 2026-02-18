import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One-shot memory consolidation using the Anthropic Messages API directly.
 * Reads daily logs from an agent directory and produces consolidated MEMORY.md content.
 * No SDK dependency — works for any template.
 */
export async function consolidateMemory(mindDir: string): Promise<void> {
  const soulPath = resolve(mindDir, "home/SOUL.md");
  const memoryPath = resolve(mindDir, "home/MEMORY.md");
  const memoryDir = resolve(mindDir, "home/memory");

  const soul = readFileSync(soulPath, "utf-8");

  // Read all daily logs
  const logs: string[] = [];
  try {
    const files = readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
    for (const filename of files) {
      const date = filename.replace(".md", "");
      const content = readFileSync(resolve(memoryDir, filename), "utf-8").trim();
      if (content) {
        logs.push(`### ${date}\n\n${content}`);
      }
    }
  } catch {
    // No logs directory
  }

  if (logs.length === 0) {
    console.log("No daily logs found.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set, skipping memory consolidation.");
    return;
  }

  console.log("Consolidating memory from daily logs...");

  const userMessage = [
    "You have daily logs from a previous environment but no long-term memory file yet.",
    "Please review the daily logs below and produce consolidated MEMORY.md content.",
    "Keep it concise and organized by topic. Output ONLY the markdown content for MEMORY.md, nothing else.",
    "",
    "## Daily logs",
    "",
    logs.join("\n\n"),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: soul,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Anthropic API error (${res.status}): ${body}`);
    return;
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const content = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("")
    .trim();

  if (content) {
    writeFileSync(memoryPath, `${content}\n`);
    console.log("MEMORY.md created successfully.");
  } else {
    console.warn("Warning: No content produced.");
  }
}
