import { readVariants, checkHealth, writeVariants, type Variant } from "../lib/variants.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    json: { type: "boolean" },
  });

  const { json } = flags;
  const projectRoot = process.cwd();
  const variants = readVariants(projectRoot);

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

  // Update variants.json to clear dead PIDs
  const updated = results.map(({ status, ...v }) => ({
    ...v,
    pid: status === "dead" ? null : v.pid,
  }));
  writeVariants(projectRoot, updated);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Print table
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const portW = Math.max(4, ...results.map((r) => String(r.port || "-").length));

  console.log(
    `${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  ${"STATUS".padEnd(10)}  BRANCH`,
  );
  for (const r of results) {
    console.log(
      `${r.name.padEnd(nameW)}  ${String(r.port || "-").padEnd(portW)}  ${r.status.padEnd(10)}  ${r.branch}`,
    );
  }
}
