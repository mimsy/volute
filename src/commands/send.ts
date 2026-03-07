import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { extname } from "node:path";
import { getClient, urlOf } from "../lib/api-client.js";
import type { ImageAttachment } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { parseTarget } from "../lib/parse-target.js";
import { readStdin } from "../lib/read-stdin.js";
import { findMind } from "../lib/registry.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function loadImage(imagePath: string): ImageAttachment {
  if (!existsSync(imagePath)) {
    console.error(`Image file not found: ${imagePath}`);
    process.exit(1);
  }
  const ext = extname(imagePath).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) {
    console.error(`Unsupported image format: ${ext} (supported: png, jpg, jpeg, gif, webp)`);
    process.exit(1);
  }
  const data = readFileSync(imagePath).toString("base64");
  return { media_type: mediaType, data };
}

/** Wait for the mind to reply in the conversation via the normal volute channel system. */
async function waitForResponse(
  mindName: string,
  conversationId: string,
  timeoutMs: number,
): Promise<void> {
  const client = getClient();
  const eventPath = urlOf(
    client.api.minds[":name"].conversations[":id"].events.$url({
      param: { name: mindName, id: conversationId },
    }),
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await daemonFetch(eventPath, {
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    console.error("Could not connect to event stream. Is the mind running?");
    process.exit(1);
  }

  if (!response.body) {
    clearTimeout(timeout);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop()!;

      for (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue; // keep-alive ping

          let event: {
            type: string;
            senderName?: string;
            content?: { type: string; text?: string }[];
          };
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === "message" && event.senderName === mindName && event.content) {
            const text = event.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
              .map((b) => b.text)
              .join("");
            if (text) {
              process.stdout.write(`${text}\n`);
            }
            return;
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.error(`(timed out after ${timeoutMs / 1000}s)`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => {});
  }
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    image: { type: "string" },
    wait: { type: "boolean" },
    timeout: { type: "number" },
    sender: { type: "string" },
  });

  const target = positional[0];
  const message = positional[1] ?? (await readStdin());

  const images = flags.image ? [loadImage(flags.image)] : undefined;

  if (!target || (!message && !images)) {
    console.error(
      'Usage: volute send <target> "<message>" [--mind <name>] [--image <path>] [--wait]',
    );
    console.error('       echo "message" | volute send <target> [--mind <name>]');
    console.error("");
    console.error("Examples:");
    console.error('  volute send @other-mind "hello"');
    console.error('  volute send animal-chat "hello everyone"');
    console.error('  volute send discord:server/channel "hello"');
    console.error('  volute send @mind "check this out" --image photo.png');
    console.error("  volute send @mind --image photo.png");
    console.error('  volute send @mind "hello" --wait');
    process.exit(1);
  }

  // Catch attempts to reply to system messages (with or without @)
  if (target === "system" || target === "@system") {
    console.error(
      "Can't send to system — system messages are automated.\n" +
        'To reply to a person, use their username from the message prefix (e.g. volute send @username "msg").',
    );
    process.exit(1);
  }

  let parsed = parseTarget(target);

  // If bare name matches a registered mind, treat as a DM (e.g. "sprout" → "@sprout")
  if (!parsed.isDM && parsed.platform === "volute" && findMind(parsed.identifier)) {
    parsed = {
      platform: "volute",
      identifier: `@${parsed.identifier}`,
      uri: `volute:@${parsed.identifier}`,
      isDM: true,
    };
  }

  const client = getClient();

  // Resolve the target mind name for --wait
  let waitMindName: string | undefined;

  let channelUri = parsed.uri;

  if (parsed.isDM && parsed.platform === "volute") {
    // For volute DMs (@target), create/find conversation via daemon
    const targetName = parsed.identifier.slice(1); // strip @
    const mindSelf = process.env.VOLUTE_MIND;
    const sender = flags.sender || mindSelf || userInfo().username;

    waitMindName = findMind(targetName) ? targetName : undefined;

    // When a mind sends to a non-mind (human), use the sender mind's context
    // so the conversation is created under the mind (humans aren't in the registry).
    const targetIsMind = !!findMind(targetName);
    const contextMind = mindSelf && !targetIsMind ? mindSelf : targetName;
    const participants = mindSelf && !targetIsMind ? [targetName] : [sender];

    // Create/find conversation via daemon
    const createRes = await daemonFetch(
      urlOf(client.api.minds[":name"].channels.create.$url({ param: { name: contextMind } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "volute", participants, sender }),
      },
    );
    if (!createRes.ok) {
      const data = await createRes.json().catch(() => ({ error: "Unknown error" }));
      console.error((data as { error: string }).error);
      process.exit(1);
    }
    const { slug } = (await createRes.json()) as { slug: string };
    channelUri = slug;

    // Send via daemon
    const sendRes = await daemonFetch(
      urlOf(client.api.minds[":name"].channels.send.$url({ param: { name: contextMind } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "volute",
          uri: channelUri,
          message: message ?? "",
          images,
          sender,
        }),
      },
    );
    if (!sendRes.ok) {
      const data = await sendRes.json().catch(() => ({ error: "Unknown error" }));
      console.error((data as { error: string }).error);
      process.exit(1);
    }
    if (!flags.wait) console.log("Message sent.");

    // Persist outgoing to mind_messages if sender is a registered mind
    if (mindSelf) {
      try {
        const histRes = await daemonFetch(
          urlOf(client.api.minds[":name"].history.$url({ param: { name: mindSelf } })),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: parsed.uri, content: message ?? "" }),
          },
        );
        if (!histRes.ok) {
          console.error(`Failed to persist to history: HTTP ${histRes.status}`);
        }
      } catch (err) {
        console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else {
    // For all other targets, send through the daemon channel API
    const mindName = resolveMindName(flags);

    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].channels.send.$url({ param: { name: mindName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: parsed.platform,
          uri: channelUri,
          message: message ?? "",
          images,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Unknown error" }));
      console.error((body as { error: string }).error);
      process.exit(1);
    }
    if (!flags.wait) console.log("Message sent.");

    // Persist outgoing to mind_messages if sender is a registered mind
    if (process.env.VOLUTE_MIND) {
      try {
        const histRes = await daemonFetch(
          urlOf(client.api.minds[":name"].history.$url({ param: { name: mindName } })),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: channelUri, content: message ?? "" }),
          },
        );
        if (!histRes.ok) {
          console.error(`Failed to persist to history: HTTP ${histRes.status}`);
        }
      } catch (err) {
        console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (flags.wait && waitMindName) {
    // Extract conversation ID from the channel URI (format: "volute:<id>")
    const conversationId = channelUri.startsWith("volute:") ? channelUri.slice(7) : undefined;
    if (!conversationId) {
      console.error("--wait requires a volute conversation (DM to a mind)");
      process.exit(1);
    }
    await waitForResponse(waitMindName, conversationId, flags.timeout ?? 120_000);
  } else if (flags.wait && !waitMindName) {
    console.error("--wait is only supported when sending to a mind");
    process.exit(1);
  }
}
