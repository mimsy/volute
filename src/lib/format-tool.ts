export function summarizeTool(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const args = input as Record<string, unknown>;
    const val = args.path ?? args.command ?? args.query ?? args.url;
    if (typeof val === "string") {
      const brief = val.length > 60 ? `${val.slice(0, 57)}...` : val;
      return `[${name} ${brief}]`;
    }
  }
  return `[${name}]`;
}
