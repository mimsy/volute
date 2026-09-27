/**
 * How a notice that can be read from any thread should name the thread it is about.
 *
 * Amnesia notices are recorded mind-level so they can't strand (#768), which means the
 * reader may be somewhere else entirely and "this thread" points at nothing. Ephemeral
 * `new-*` sessions are named after nothing the mind has ever seen, so naming one would
 * be worse than not naming it.
 */
export function threadRef(name: string): string {
  return name.startsWith("new-") ? "a one-off session" : `the \`${name}\` thread`;
}
