import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "read":
      await readChannel(args.slice(1));
      break;
    case "list":
      await listChannels(args.slice(1));
      break;
    case "users":
      await listUsers(args.slice(1));
      break;
    case "create":
      await createChannel(args.slice(1));
      break;
    case "typing":
      await typingChannel(args.slice(1));
      break;
    case "invite":
      await inviteChannel(args.slice(1));
      break;
    case "pending":
      await pendingChannel(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute channel read <channel-uri> [--limit N] [--mind <name>]
  volute channel list [<platform>] [--mind <name>]
  volute channel users <platform> [--mind <name>]
  volute channel create <platform> --participants user1,user2 [--name "..."] [--mind <name>]
  volute channel typing <channel-uri> [--mind <name>]
  volute channel invite <channel-name> <username>
  volute channel pending [--mind <name>]`);
}

async function readChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    limit: { type: "number" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel read <channel-uri> [--limit N] [--mind <name>]");
    process.exit(1);
  }

  const mindName = resolveMindName(flags);
  const { platform } = parseUri(uri);
  const limit = flags.limit ?? 20;

  const client = getClient();
  const url = client.api.minds[":name"].channels.read.$url({ param: { name: mindName } });
  url.searchParams.set("platform", platform);
  url.searchParams.set("uri", uri);
  url.searchParams.set("limit", String(limit));

  const res = await daemonFetch(urlOf(url));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }
  const output = await res.text();
  console.log(output);
}

async function listChannels(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const platform = positional[0];
  const mindName = resolveMindName(flags);

  const client = getClient();
  const url = client.api.minds[":name"].channels.list.$url({ param: { name: mindName } });
  if (platform) url.searchParams.set("platform", platform);

  const res = await daemonFetch(urlOf(url));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const results = (await res.json()) as Record<
    string,
    { id: string; name: string; type: string; participantCount?: number; error?: string }[]
  >;
  for (const [p, convs] of Object.entries(results)) {
    for (const conv of convs) {
      if (conv.error) {
        console.error(`${p}: ${conv.error}`);
        continue;
      }
      const parts = [conv.id.padEnd(24), conv.name.padEnd(28), conv.type];
      if (conv.participantCount != null) {
        parts.push(String(conv.participantCount));
      }
      console.log(parts.join("  "));
    }
  }
}

async function listUsers(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const platform = positional[0];
  if (!platform) {
    console.error("Usage: volute channel users <platform> [--mind <name>]");
    process.exit(1);
  }

  const mindName = resolveMindName(flags);

  const client = getClient();
  const url = client.api.minds[":name"].channels.users.$url({ param: { name: mindName } });
  url.searchParams.set("platform", platform);

  const res = await daemonFetch(urlOf(url));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const users = (await res.json()) as { username: string; id: string; type?: string }[];
  for (const user of users) {
    console.log(`${user.username.padEnd(20)}  ${user.id.padEnd(20)}  ${user.type ?? ""}`);
  }
}

async function createChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    participants: { type: "string" },
    name: { type: "string" },
  });

  const platform = positional[0];
  if (!platform || !flags.participants) {
    console.error(
      'Usage: volute channel create <platform> --participants user1,user2 [--name "..."] [--mind <name>]',
    );
    process.exit(1);
  }

  const mindName = resolveMindName(flags);
  const participants = flags.participants.split(",").map((s) => s.trim());

  const client = getClient();
  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].channels.create.$url({ param: { name: mindName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, participants, name: flags.name }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }
  const data = (await res.json()) as { slug: string };
  console.log(data.slug);
}

async function typingChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel typing <channel-uri> [--mind <name>]");
    process.exit(1);
  }

  const mindName = resolveMindName(flags);

  try {
    const client = getClient();
    const url = client.api.minds[":name"].typing.$url({ param: { name: mindName } });
    url.searchParams.set("channel", uri);

    const res = await daemonFetch(urlOf(url));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(body.error ?? `Server responded with ${res.status}`);
      process.exit(1);
    }
    const data = (await res.json()) as { typing: string[] };
    if (data.typing.length > 0) {
      console.log(data.typing.join(", "));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function inviteChannel(args: string[]) {
  const { positional } = parseArgs(args, {});

  const channelName = positional[0];
  const username = positional[1];
  if (!channelName || !username) {
    console.error("Usage: volute channel invite <channel-name> <username>");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/volute/channels/${encodeURIComponent(channelName)}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }
  console.log(`Invited ${username} to #${channelName}`);
}

async function pendingChannel(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/delivery/pending`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const pending = (await res.json()) as {
    channel: string | null;
    sender: string | null;
    count: number;
    firstSeen: string;
    preview: string;
  }[];

  if (pending.length === 0) {
    console.log("No pending messages.");
    return;
  }

  for (const entry of pending) {
    console.log(
      `${(entry.channel ?? "unknown").padEnd(30)}  ${String(entry.count).padEnd(6)}  ${entry.sender ?? "unknown"}`,
    );
    console.log(`  First seen: ${entry.firstSeen}`);
    console.log(`  Preview: ${entry.preview}`);
    console.log();
  }
}

function parseUri(uri: string): { platform: string; channelId: string } {
  const colonIdx = uri.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid channel URI: ${uri} (expected format: platform:id)`);
    process.exit(1);
  }
  return { platform: uri.slice(0, colonIdx), channelId: uri.slice(colonIdx + 1) };
}
