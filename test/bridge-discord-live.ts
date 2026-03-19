/**
 * Live Discord bridge integration test.
 *
 * Prerequisites:
 *   - Daemon running (`volute up`)
 *   - DISCORD_TOKEN set in env (via `volute env set DISCORD_TOKEN <token>`)
 *
 * Usage:
 *   npx tsx test/bridge-discord-live.ts --channel "server/channel" [--volute-channel name] [--mind name]
 *
 * The script will:
 *   1. Create a Volute channel
 *   2. Enable the Discord bridge
 *   3. Map the Discord channel to the Volute channel
 *   4. Wait for you to send a message on Discord in that channel
 *   5. Verify the message appears in the Volute conversation
 *   6. Clean up
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const discordChannel = getArg("channel");
const voluteChannelName = getArg("volute-channel") ?? "bridge-test";
const mindName = getArg("mind") ?? "luna";

if (!discordChannel) {
  console.error(
    'Usage: npx tsx test/bridge-discord-live.ts --channel "server/channel" [--volute-channel name] [--mind name]',
  );
  process.exit(1);
}

// Read daemon config
const systemDir = resolve(homedir(), ".volute/system");
const daemonPath = resolve(systemDir, "daemon.json");
if (!existsSync(daemonPath)) {
  console.error("Daemon not running — start with `volute up`");
  process.exit(1);
}
const daemonConfig = JSON.parse(readFileSync(daemonPath, "utf-8"));
const { port, token } = daemonConfig;
const BASE = `http://127.0.0.1:${port}`;

async function api(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Origin", BASE);
  return fetch(`${BASE}${path}`, { ...options, headers });
}

type ContentBlock = { type: string; text?: string };
type Message = { content: ContentBlock[]; sender_name: string };
type Channel = { name: string; id: string };
type Bridge = { platform: string; enabled: boolean; running: boolean; defaultMind: string };

async function main() {
  console.log("=== Live Discord Bridge Test ===\n");

  // Step 1: Create volute channel
  console.log(`Creating volute channel: ${voluteChannelName}`);
  const createRes = await api("/api/v1/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: voluteChannelName }),
  });
  if (createRes.status === 201) {
    console.log("+ Channel created");
  } else if (createRes.status === 409) {
    console.log("+ Channel already exists");
  } else {
    console.error(`Failed to create channel: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }

  // Step 2: Enable Discord bridge
  console.log("\nEnabling Discord bridge...");
  const enableRes = await api("/api/bridges/discord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultMind: mindName }),
  });
  if (enableRes.status === 200) {
    console.log("+ Discord bridge enabled");
  } else {
    const body = await enableRes.json();
    console.error("Failed to enable bridge:", body);
    process.exit(1);
  }

  // Step 3: Map Discord channel
  console.log(`\nMapping ${discordChannel} -> ${voluteChannelName}`);
  const mapRes = await api("/api/bridges/discord/mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalChannel: discordChannel,
      voluteChannel: voluteChannelName,
    }),
  });
  if (mapRes.status === 200) {
    console.log("+ Mapping set");
  } else {
    console.error(`Failed to set mapping: ${await mapRes.text()}`);
  }

  // Step 4: Wait for message
  const marker = `BRIDGE_TEST_${Date.now()}`;
  console.log("\n=== ACTION REQUIRED ===");
  console.log(`Send a message in Discord channel: ${discordChannel}`);
  console.log(`The message should contain: ${marker}`);
  console.log("Waiting up to 120 seconds...\n");

  // Poll for the message
  const deadline = Date.now() + 120_000;
  let found = false;
  while (Date.now() < deadline) {
    const channelsRes = await api("/api/v1/channels");
    const channels = (await channelsRes.json()) as Channel[];
    const ch = channels.find((c) => c.name === voluteChannelName);

    if (ch) {
      const msgsRes = await api(`/api/minds/${mindName}/conversations/${ch.id}/messages?limit=10`);
      if (msgsRes.status === 200) {
        const messages = (await msgsRes.json()) as Message[];
        for (const msg of messages) {
          const text = msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text.includes(marker)) {
            found = true;
            console.log(`+ Message found from ${msg.sender_name}: "${text}"`);
            break;
          }
        }
      }
    }

    if (found) break;
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(".");
  }

  if (!found) {
    console.log("\nx Timed out waiting for message");
  }

  // Step 5: Show bridge status
  console.log("\nBridge status:");
  const bridgesRes = await api("/api/bridges");
  const bridges = (await bridgesRes.json()) as Bridge[];
  for (const b of bridges) {
    console.log(
      `  ${b.platform}: enabled=${b.enabled} running=${b.running} default=${b.defaultMind}`,
    );
  }

  // Cleanup
  console.log("\nCleaning up...");
  await api("/api/bridges/discord", { method: "DELETE" });
  console.log("+ Discord bridge disabled");

  console.log("\n=== Done ===");
  process.exit(found ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
