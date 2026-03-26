export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n/, "");
  }
  if (text) chunks.push(text);
  return chunks;
}
