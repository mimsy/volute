import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { checkHealth, readVariants, type Variant, writeVariants } from "../lib/variants.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    json: { type: "boolean" },
  });

  const name = positional[0];
  if (!name) {
    console.error("Usage: volute variants <name>");
    process.exit(1);
  }

  const { json } = flags;
  resolveAgent(name); // validate agent exists
  const variants = readVariants(name);

  if (variants.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No variants.");
    }
    return;
  }

  // Health-check all variants in parallel
  const results: (Variant & { status: string })[] = await Promise.all(
    variants.map(async (v) => {
      if (!v.port) return { ...v, status: "no-server" };
      const health = await checkHealth(v.port);
      return { ...v, status: health.ok ? "running" : "dead" };
    }),
  );

  // Update variants.json to clear running status for dead variants
  const updated = results.map(({ status, ...v }) => ({
    ...v,
    running: status === "running",
  }));
  writeVariants(name, updated);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Print table
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const portW = Math.max(4, ...results.map((r) => String(r.port || "-").length));

  console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  ${"STATUS".padEnd(10)}  BRANCH`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(nameW)}  ${String(r.port || "-").padEnd(portW)}  ${r.status.padEnd(10)}  ${r.branch}`,
    );
  }
}
