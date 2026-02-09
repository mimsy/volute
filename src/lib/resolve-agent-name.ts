export function resolveAgentName(flags: { agent?: string }): string {
  const name = flags.agent || process.env.VOLUTE_AGENT;
  if (!name) {
    console.error("No agent specified. Use --agent <name> or set VOLUTE_AGENT.");
    process.exit(1);
  }
  return name;
}
