import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, extname } from "node:path";
import { getClient, urlOf } from "../lib/api-client.js";
import type { ImageAttachment } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { formatFileSize } from "../lib/file-sharing.js";
import { parseArgs } from "../lib/parse-args.js";
import { parseTarget } from "../lib/parse-target.js";
import { readStdin } from "../lib/read-stdin.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

/** Check if a name is a registered mind via the daemon API (avoids direct DB access). */
async function isMind(name: string): Promise<boolean> {
  try {
    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}`);
    return res.ok;
  } catch {
    return false;
  }
}

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
    file: { type: "string" },
    wait: { type: "boolean" },
    timeout: { type: "number" },
    sender: { type: "string" },
  });

  const target = positional[0];
  const message = positional[1] ?? (await readStdin());

  const images = flags.image ? [loadImage(flags.image)] : undefined;

  if (!target || (!message && !images && !flags.file)) {
    console.error(
      'Usage: volute chat send <target> "<message>" [--mind <name>] [--image <path>] [--file <path>] [--wait]',
    );
    console.error('       echo "message" | volute chat send <target> [--mind <name>]');
    console.error("");
    console.error("Examples:");
    console.error('  volute chat send @other-mind "hello"');
    console.error('  volute chat send animal-chat "hello everyone"');
    console.error('  volute chat send discord:server/channel "hello"');
    console.error('  volute chat send @mind "check this out" --image photo.png');
    console.error("  volute chat send @mind --image photo.png");
    console.error('  volute chat send @mind "check this out" --file notes.txt');
    console.error('  volute chat send @mind "hello" --wait');
    process.exit(1);
  }

  // Catch attempts to reply to system messages (with or without @)
  if (target === "system" || target === "@system") {
    console.error(
      "Can't send to system — system messages are automated.\n" +
        'To reply to a person, use their username from the message prefix (e.g. volute chat send @username "msg").',
    );
    process.exit(1);
  }

  // Handle --file: stage file for the target mind, then send a notification message
  if (flags.file) {
    const filePath = flags.file;

    // Resolve target mind name
    const parsed = parseTarget(target);
    const targetName =
      parsed.isDM && parsed.platform === "volute"
        ? parsed.identifier.slice(1) // strip @
        : parsed.identifier;

    // For mind senders, use the daemon file-send API (reads from mind's home/)
    const mindSelf = process.env.VOLUTE_MIND;
    if (mindSelf) {
      const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindSelf)}/files/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMind: targetName, filePath }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        console.error(data.error ?? `Failed to send file: ${res.status}`);
        process.exit(1);
      }
      const data = (await res.json()) as { id: string };
      console.log(`File staged for ${targetName} (id: ${data.id})`);
    } else {
      // For CLI (human) senders, read file locally and stage via daemon API
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const stat = statSync(filePath);
      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
      if (stat.size > MAX_FILE_SIZE) {
        console.error(
          `File too large (${formatFileSize(stat.size)}, max ${formatFileSize(MAX_FILE_SIZE)})`,
        );
        process.exit(1);
      }

      const content = readFileSync(filePath);
      const filename = basename(filePath);
      const senderName = flags.sender || userInfo().username;

      // Stage the file directly via the daemon's accept-raw endpoint
      const res = await daemonFetch(`/api/minds/${encodeURIComponent(targetName)}/files/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: senderName,
          filename,
          data: content.toString("base64"),
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        console.error(data.error ?? `Failed to stage file: ${res.status}`);
        process.exit(1);
      }
      const data = (await res.json()) as { id: string };
      console.log(`File staged for ${targetName} (id: ${data.id})`);
    }

    // If there's also a text message, send it through the normal chat flow
    if (!message) return;
  }

  let parsed = parseTarget(target);

  // If bare name matches a registered mind, treat as a DM (e.g. "sprout" → "@sprout")
  if (!parsed.isDM && parsed.platform === "volute" && (await isMind(parsed.identifier))) {
    parsed = {
      platform: "volute",
      identifier: `@${parsed.identifier}`,
      uri: `@${parsed.identifier}`,
      isDM: true,
    };
  }

  const client = getClient();

  // Resolve the target mind name for --wait
  let waitMindName: string | undefined;
  let waitConversationId: string | undefined;

  let channelUri = parsed.uri;

  if (parsed.isDM && parsed.platform === "volute") {
    // For volute DMs (@target), create/find conversation via daemon
    const targetName = parsed.identifier.slice(1); // strip @
    const mindSelf = process.env.VOLUTE_MIND;
    const sender = flags.sender || mindSelf || userInfo().username;

    const targetIsMind = await isMind(targetName);
    waitMindName = targetIsMind ? targetName : undefined;

    // Use the sender mind's context when VOLUTE_MIND is set (so the daemon
    // token matches), otherwise use the target mind's context.
    const contextMind = mindSelf ?? targetName;
    const participants = mindSelf ? [targetName] : [sender];

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
    const { slug, conversationId: convId } = (await createRes.json()) as {
      slug: string;
      conversationId?: string;
    };
    channelUri = slug;
    if (convId) waitConversationId = convId;

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
    if (!waitConversationId) {
      console.error("--wait requires a volute conversation (DM to a mind)");
      process.exit(1);
    }
    await waitForResponse(waitMindName, waitConversationId, flags.timeout ?? 120_000);
  } else if (flags.wait && !waitMindName) {
    console.error("--wait is only supported when sending to a mind");
    process.exit(1);
  }
}
