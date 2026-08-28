/**
 * Refuse a numeric flag outside the range the server will actually honour.
 *
 * Every route that pages has a cap, and a request past it comes back as a full, correct,
 * plausible page of the wrong size. Serving 100 rows for a request of 500 and saying
 * nothing is the same species of silence as an ignored flag: the caller gets real output
 * and no way to know it is not the output they asked for. The caps live at the call sites
 * next to the route they belong to; this is only the shared shape of the refusal, so the
 * wording every mind reads stays identical across flags.
 */
export function assertRange(
  flag: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (value < min || value > max) {
    console.error(`error: ${flag} must be between ${min} and ${max} (got ${value})`);
    process.exit(1);
  }
}
