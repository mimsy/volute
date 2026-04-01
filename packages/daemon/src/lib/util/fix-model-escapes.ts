/**
 * Fix common escape-sequence errors in model-generated text.
 *
 * \! → ! — always applied (never a valid escape in JSON strings;
 *          models copy the habit from bash history expansion / LaTeX).
 *
 * \\n → newline, \\t → tab — opt-in per mind, for models that
 *          double-escape whitespace in tool call arguments.
 */
export function fixModelEscapes(text: string, unescapeNewlines: boolean): string {
  let result = text.replaceAll("\\!", "!");
  if (unescapeNewlines) {
    result = result.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  }
  return result;
}
