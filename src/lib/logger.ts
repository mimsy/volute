export function log(category: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${category}]`, ...args);
}
