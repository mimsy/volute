import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";
import { readSystemsConfig } from "../../lib/systems-config.js";
import { systemsFetch } from "../../lib/systems-fetch.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    system: { type: "boolean" },
  });

  const config = readSystemsConfig();
  if (!config) {
    console.error('Not logged in. Run "volute pages register" or "volute pages login" first.');
    process.exit(1);
  }

  let mindName: string;
  if (flags.system) {
    mindName = "system";
  } else if (flags.mind || process.env.VOLUTE_MIND) {
    mindName = resolveMindName(flags);
  } else {
    mindName = "system";
  }

  const res = await systemsFetch(`${config.apiUrl}/api/pages/status/${mindName}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

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
