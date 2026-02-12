import { isatty } from "node:tty";

/**
 * Read all of stdin as a string, trimming trailing newline.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
export async function readStdin(): Promise<string | undefined> {
  if (isatty(0)) return undefined;

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
  } catch (err) {
    console.error(`Failed to read from stdin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const text = Buffer.concat(chunks)
    .toString()
    .replace(/\r?\n$/, "");
  return text || undefined;
}
