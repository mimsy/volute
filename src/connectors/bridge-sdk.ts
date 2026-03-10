/**
 * Bridge SDK — used by bridge processes to write messages into Volute conversations
 * via the daemon API, instead of sending directly to minds.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export interface BridgeEnv {
  daemonUrl: string;
  daemonToken: string;
  platform: string;
}

export function loadBridgeEnv(): BridgeEnv {
  const daemonUrl = process.env.VOLUTE_DAEMON_URL;
  const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;
  const platform = process.env.VOLUTE_BRIDGE_PLATFORM;

  if (!daemonUrl || !daemonToken || !platform) {
    console.error(
      "Missing required env vars: VOLUTE_DAEMON_URL, VOLUTE_DAEMON_TOKEN, VOLUTE_BRIDGE_PLATFORM",
    );
    process.exit(1);
  }

  return { daemonUrl, daemonToken, platform };
}

function getHeaders(env: BridgeEnv): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.daemonToken}`,
    Origin: env.daemonUrl,
  };
}

export interface BridgeMessage {
  content: ContentPart[];
  /** Platform user identifier (e.g. Discord username, Slack user ID) */
  platformUserId: string;
  /** Display name of the sender */
  displayName: string;
  /** External channel slug (e.g. "my-server/general") */
  externalChannel: string;
  /** Whether this is a DM */
  isDM: boolean;
  /** For DMs: which mind to route to (can be overridden by mentions) */
  targetMind?: string;
}

/**
 * Send a message from an external platform into the Volute conversation system.
 * The daemon handles puppet user creation, conversation resolution, and fan-out.
 */
export async function sendToBridge(
  env: BridgeEnv,
  message: BridgeMessage,
): Promise<{ ok: boolean; error?: string; conversationId?: string }> {
  const url = `${env.daemonUrl}/api/bridges/${env.platform}/inbound`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Bridge inbound returned ${res.status}: ${body}`);
      return { ok: false, error: `Bridge returned ${res.status}` };
    }

    return (await res.json()) as { ok: boolean; error?: string; conversationId?: string };
  } catch (err) {
    console.error(`Failed to send bridge message: ${err}`);
    return { ok: false, error: "Failed to reach daemon" };
  }
}

export function onShutdown(cleanup: () => void | Promise<void>): void {
  const handler = () => {
    Promise.resolve(cleanup()).then(
      () => process.exit(0),
      (err) => {
        console.error(`Shutdown error: ${err}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n/, "");
  }
  if (text) chunks.push(text);
  return chunks;
}
