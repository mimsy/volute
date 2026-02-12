import { isatty } from "node:tty";

/**
 * Read all of stdin as a string, trimming trailing newline.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
export async function readStdin(): Promise<string | undefined> {
  if (isatty(0)) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString().replace(/\n$/, "");
  return text || undefined;
}
