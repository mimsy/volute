export function resolveMindName(flags: { mind?: string }): string {
  const name = flags.mind || process.env.VOLUTE_MIND;
  if (!name) {
    console.error("No mind specified. Provide a name or set VOLUTE_MIND.");
    process.exit(1);
  }
  return name;
}
