import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    system: { type: "boolean" },
  });

  const mindName = flags.mind || process.env.VOLUTE_MIND ? resolveMindName(flags) : "system";

  const res = await daemonFetch(`/api/system/pages/status/${mindName}`);

  if (!res.ok) {
    if (res.status === 404) {
      console.log(`${mindName} has not been published yet.`);
      return;
    }
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Failed to get status: ${body.error}`);
    process.exit(1);
  }

  const { url, fileCount, deployedAt } = (await res.json()) as {
    url: string;
    fileCount: number;
    deployedAt: string;
  };

  console.log(`URL:       ${url}`);
  console.log(`Files:     ${fileCount}`);
  console.log(`Published: ${deployedAt}`);
}
