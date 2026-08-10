import { isatty } from "node:tty";

/**
 * How long to wait for the *first* byte of piped input before giving up.
 *
 * Guards against callers whose stdin is a pipe nobody ever closes — an agent's
 * shell tool, cron, `ssh host cmd` holding the channel open. Draining such a
 * stream to EOF never returns, and a command that hangs with no output is the
 * worst failure there is: nothing to read, nothing to reason from (#872).
 */
const FIRST_BYTE_TIMEOUT_MS = 5000;

/**
 * Read all of stdin as a string, trimming trailing newline.
 * Returns undefined if stdin is a TTY (interactive terminal), if the stream is
 * empty, or if no input arrives within `timeoutMs`.
 *
 * The timeout covers only the first byte: once a producer has started writing,
 * the stream is read to EOF as before, so slow producers are never truncated.
 *
 * It applies to every caller on purpose, not just the extension dispatch that
 * prompted it: `volute chat send <target>` with no message, and `mind history --write
 * --turn <id>` with no `--text`, both reach here and hang on an open pipe for the same
 * reason, and a hang is a bug wherever it happens. The cost is that a producer
 * slower than `timeoutMs` to its first byte has its input dropped, so the guard
 * always says so on stderr: an ignored input a mind can read about is a different
 * thing from one it cannot.
 */
export async function readStdin(opts?: { timeoutMs?: number }): Promise<string | undefined> {
  if (isatty(0)) return undefined;

  const timeoutMs = opts?.timeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  const stdin = process.stdin;

  let timedOut = false;
  try {
    timedOut = await new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
      };
      const onData = (chunk: Buffer) => {
        clearTimeout(timer);
        chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve(false);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        // Stop referencing the still-open pipe, or the process would stay alive
        // waiting on it — trading a hang before the work for one after it.
        stdin.pause();
        stdin.unref?.();
        // This is the one path that walks away from a *live* stream, so it has to
        // leave a listener behind. `process.stdin` is a long-lived singleton and
        // nothing else in the CLI handles its errors: if the abandoned pipe later
        // fails (EPIPE when the writer dies, ECONNRESET when an ssh channel drops),
        // an 'error' with no listener is thrown as an uncaught exception and kills
        // the command mid-work — the same defect as #864, reached by exactly the
        // callers #872 exists to protect.
        stdin.on("error", () => {});
        resolve(true);
      }, timeoutMs);

      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("error", onError);
    });
  } catch (err) {
    console.error(`Failed to read from stdin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (timedOut) {
    console.error(
      `No input on stdin after ${timeoutMs}ms — continuing without it. ` +
        `Redirect with \`</dev/null\` if you did not mean to pipe anything.`,
    );
    return undefined;
  }

  const text = Buffer.concat(chunks)
    .toString()
    .replace(/\r?\n$/, "");
  return text || undefined;
}
