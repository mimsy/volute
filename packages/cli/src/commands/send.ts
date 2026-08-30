import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, extname } from "node:path";
import { isMind as isMindUser } from "@volute/api/user-type";
import { formatFileSize } from "@volute/daemon/lib/chat/file-sharing.js";
import type { SpiritStatus } from "@volute/daemon/lib/chat/spirit-availability.js";
import type { ImageAttachment } from "@volute/daemon/lib/platforms.js";
import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { isCompact } from "../lib/format-cli.js";
import { parseTarget } from "../lib/parse-target.js";
import { readStdin } from "../lib/read-stdin.js";

/** Check if a name is a registered mind via the daemon API (avoids direct DB access). */
async function isMind(name: string): Promise<boolean> {
  try {
    const res = await daemonFetch(`/api/v1/minds/${encodeURIComponent(name)}`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The mind this process *is*, as opposed to one it merely operates on.
 *
 * `VOLUTE_MIND` alone is a documented host-side convenience for mind-scoped commands
 * (`volute clock`, `volute skill`), so a host who exported it is still speaking as
 * themselves. Only a mind process is handed `VOLUTE_MIND_TOKEN` alongside it — the same
 * condition `readDaemonConfig()` uses to switch to the mind's token. Treating the bare
 * env var as an identity claim would 403 that host on every message they send (#500).
 */
function selfMindIdentity(): string | undefined {
  return process.env.VOLUTE_MIND_TOKEN ? process.env.VOLUTE_MIND : undefined;
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
    client.api.v1.minds[":name"].conversations[":id"].events.$url({
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

type SendResult = {
  held?: boolean;
  notice?: string;
  outboundId?: number;
  spirit?: SpiritStatus;
};

/** A one-line acknowledgment of the spirit's availability when it's a recipient (#434). */
function spiritAck(spirit: SpiritStatus | undefined): string | null {
  switch (spirit) {
    case "waking":
      return "The system spirit is waking — a reply is on its way.";
    case "sleeping":
      return "The system spirit is sleeping — it will reply when it wakes.";
    case "unavailable":
      return "The system spirit is unavailable — an admin can fix this in Settings.";
    default:
      return null;
  }
}

/**
 * Print the daemon's advisory tail for a completed send: any notice (e.g. a recipient
 * holding the message pending channel approval) and the spirit availability ack. Shared
 * by the normal confirmation and the --wait path (which skips the confirmation but must
 * still surface these — a gated recipient or unavailable spirit won't reply).
 */
function printSendAdvisories(data: SendResult): void {
  if (data.notice) console.log(data.notice);
  const ack = spiritAck(data.spirit);
  if (ack) console.log(ack);
}

/**
 * Print the outcome of a POST /chat send to stdout. A "held" send (a peer posted
 * while the mind was composing) prints the daemon's plain notice so the mind can
 * revise or re-send; a normal send prints the sent confirmation + outbound marker,
 * plus any daemon advisories so a "sent" message that won't be seen isn't silently
 * confirmed.
 */
function printSendResult(data: SendResult): void {
  if (data.held) {
    if (data.notice) console.log(data.notice);
    return;
  }
  const { outboundId } = data;
  if (isCompact()) {
    if (outboundId != null) console.log(`[volute:outbound:${outboundId}]`);
  } else {
    console.log(`Message sent.${outboundId != null ? `\n[volute:outbound:${outboundId}]` : ""}`);
  }
  printSendAdvisories(data);
}

const cmd = command({
  name: "volute chat send",
  description: "Send a message to a mind, channel, or platform",
  args: [
    {
      name: "target",
      required: true,
      description: "Recipient (@name, #channel, or platform:channel)",
    },
    { name: "message", description: "Message text (or pipe via stdin)" },
  ],
  flags: {
    image: { type: "string", description: "Path to image to embed" },
    file: { type: "string", description: "Path to file to send" },
    wait: { type: "boolean", description: "Wait for mind response" },
    timeout: { type: "number", description: "Response timeout in ms (default 120000)" },
    sender: {
      type: "string",
      description: "Record the message as another user (daemon-internal; refused otherwise)",
    },
  },
  examples: [
    'volute chat send @alice "hello"',
    'volute chat send "#general" "announcement"',
    "echo hi | volute chat send @alice",
  ],
  async run({ args, flags }) {
    const target = args.target!;
    const message = args.message ?? (await readStdin());

    // Who this caller claims to be speaking as, or undefined when it is simply itself.
    // Distinct from the OS username below, which answers "who is in the conversation",
    // not "whose words are these" — the daemon knows the authenticated identity and
    // attributes it when no claim is made.
    const claimedSender = flags.sender || selfMindIdentity();

    const images = flags.image ? [loadImage(flags.image)] : undefined;

    if (!message && !images && !flags.file) {
      console.error(
        'Usage: volute chat send <target> "<message>" [--image <path>] [--file <path>] [--wait]',
      );
      console.error('       echo "message" | volute chat send <target>');
      console.error("");
      console.error("Examples:");
      console.error('  volute chat send @other-mind "hello"');
      console.error('  volute chat send "#animal-chat" "hello everyone"');
      console.error('  volute chat send @mind "check this out" --image photo.png');
      console.error("  volute chat send @mind --image photo.png");
      console.error('  volute chat send @mind "check this out" --file notes.txt');
      console.error('  volute chat send @mind "hello" --wait');
      process.exit(1);
    }

    // Catch attempts to reply to the system (with or without @)
    if (target === "system" || target === "@system") {
      console.error(
        "Can't send to system — system events come from your environment, not a person, and " +
          "nothing is waiting on a reply.\n" +
          'To reach a person, use their username from the message prefix (e.g. volute chat send @username "msg").',
      );
      process.exit(1);
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

    // The mind this send resolves to, when it's a volute DM to a mind.
    const dmTargetName =
      parsed.isDM && parsed.platform === "volute" ? parsed.identifier.slice(1) : undefined;

    // Enforce --file constraints BEFORE anything is sent, so a bad combination can't
    // post the message and then fail on staging (#691). File sharing is mind-to-mind
    // into a DM; channels, non-mind recipients, and image+file-without-text can't work.
    if (flags.file) {
      if (!dmTargetName || !(await isMind(dmTargetName))) {
        console.error(
          "--file can only attach to a direct message to a mind — e.g.\n" +
            '  volute chat send @mind "here you go" --file <path>\n' +
            "Channels and non-mind recipients can't receive a file share.",
        );
        process.exit(1);
      }
      if (!message && images) {
        console.error(
          "Can't attach an image and a file without a message. Send the image with a " +
            "message, or send the file on its own.",
        );
        process.exit(1);
      }
    }

    // Stage the attached file (if any). Runs AFTER the accompanying message is
    // sent so a failed send can't strand the file offer with no context (#691):
    // the file share is only staged once the message has actually gone out.
    // `afterSend` distinguishes a staging failure that follows a delivered message
    // (the message is already out — a blind retry would duplicate it) from a bare
    // `--file` where nothing has been sent yet.
    const stageAttachedFile = async (afterSend: boolean): Promise<void> => {
      const filePath = flags.file!;
      // Guaranteed a mind DM by the --file validation above.
      const targetName = dmTargetName!;

      // A staging failure exits non-zero. When the message already went out, say so
      // — a blind retry of the whole command would re-post the message.
      const failStaging = (reason: string): never => {
        console.error(
          afterSend
            ? `Your message was delivered. Only the file failed: ${reason}\n` +
                `Retry the attachment with:  volute chat send ${target} --file ${filePath} ` +
                "(no message) — sending the whole command again would duplicate the message."
            : reason,
        );
        process.exit(1);
      };

      // Wrap the staging call so a network error or a non-JSON error body is framed
      // the same way as a clean daemon error (never an uncaught throw after send).
      const postStaging = async (
        path: string,
        body: unknown,
      ): Promise<{ id: string; notified: boolean }> => {
        let res: Response;
        try {
          res = await daemonFetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          return failStaging(`couldn't reach the daemon (${(err as Error).message})`);
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          return failStaging(data.error ?? `daemon returned ${res.status}`);
        }
        const data = (await res.json().catch(() => ({}))) as { id?: string; notified?: boolean };
        return { id: data.id ?? "?", notified: data.notified !== false };
      };

      // The file is staged either way; when the daemon says the recipient could not be
      // notified, say so — otherwise "File staged" implies they know it's waiting (#723).
      const printStaged = (targetName: string, staged: { id: string; notified: boolean }) => {
        console.log(`File staged for ${targetName} (id: ${staged.id})`);
        if (!staged.notified) {
          console.log(
            `Warning: ${targetName} could not be notified of the file — mention it to them ` +
              `directly (they can run: volute chat files).`,
          );
        }
      };

      // For mind senders, use the daemon file-send API (reads from mind's home/)
      const mindSelf = process.env.VOLUTE_MIND;
      if (mindSelf) {
        const staged = await postStaging(
          `/api/v1/minds/${encodeURIComponent(mindSelf)}/files/send`,
          {
            targetMind: targetName,
            filePath,
          },
        );
        printStaged(targetName, staged);
      } else {
        // For CLI (human) senders, read file locally and stage via daemon API
        if (!existsSync(filePath)) {
          failStaging(`File not found: ${filePath}`);
        }
        const stat = statSync(filePath);
        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
        if (stat.size > MAX_FILE_SIZE) {
          failStaging(
            `File too large (${formatFileSize(stat.size)}, max ${formatFileSize(MAX_FILE_SIZE)})`,
          );
        }

        const content = readFileSync(filePath);
        const staged = await postStaging(
          `/api/v1/minds/${encodeURIComponent(targetName)}/files/stage`,
          {
            // A file offer is announced to the recipient under this name, so it gets
            // the same rule as a message: claim only what is actually a claim, and let the
            // daemon attribute the authenticated user otherwise.
            sender: claimedSender,
            filename: basename(filePath),
            data: content.toString("base64"),
          },
        );
        printStaged(targetName, staged);
      }
    };

    // A bare --file with no message has nothing to order against — stage and stop.
    if (flags.file && !message) {
      await stageAttachedFile(false);
      return;
    }

    const client = getClient();

    // Resolve the target mind name for --wait
    let waitMindName: string | undefined;
    let waitConversationId: string | undefined;
    // The mind whose context carried a channel post — used to make the `chat read`
    // hint runnable for a host, who has no VOLUTE_MIND to default to.
    let channelContextMind: string | undefined;
    let heldResponse = false;
    let spiritUnavailable = false;

    if (parsed.isDM && parsed.platform === "volute") {
      // For volute DMs (@target), create/find conversation via daemon
      const targetName = parsed.identifier.slice(1); // strip @
      const mindSelf = process.env.VOLUTE_MIND;
      // Only used for the conversation's participant list — see claimedSender above.
      const sender = flags.sender || mindSelf || userInfo().username;

      // Sending to yourself is a dead end: it would resolve to a
      // one-participant conversation that reaches nobody.
      if (mindSelf && targetName === mindSelf) {
        console.error(
          `Can't send to @${targetName} — that's yourself. ` +
            `System events arrive from your environment and don't need a reply.`,
        );
        process.exit(1);
      }

      const targetIsMind = await isMind(targetName);
      waitMindName = targetIsMind ? targetName : undefined;

      // Use the sender mind's context when VOLUTE_MIND is set (so the daemon
      // token matches), otherwise use the target mind's context.
      const contextMind = mindSelf ?? targetName;
      const participants = mindSelf ? [targetName] : [sender];

      // Create/find conversation via daemon
      const createRes = await daemonFetch(
        urlOf(client.api.v1.minds[":name"].channels.create.$url({ param: { name: contextMind } })),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: "volute", participants, sender: claimedSender }),
        },
      );
      if (!createRes.ok) {
        const data = await createRes.json().catch(() => ({ error: "Unknown error" }));
        console.error((data as { error: string }).error);
        process.exit(1);
      }
      const { conversationId: convId } = (await createRes.json()) as {
        conversationId?: string;
      };
      if (convId) waitConversationId = convId;

      // Send via daemon chat API
      const sendRes = await daemonFetch("/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message ?? "",
          conversationId: convId,
          images,
          sender: claimedSender,
          targetMind: contextMind,
        }),
      });
      if (!sendRes.ok) {
        const data = await sendRes.json().catch(() => ({ error: "Unknown error" }));
        console.error((data as { error: string }).error);
        process.exit(1);
      }
      let data: SendResult = {};
      try {
        data = (await sendRes.json()) as SendResult;
      } catch (err) {
        console.error(`Warning: could not read send response: ${(err as Error).message}`);
      }
      if (data.held) heldResponse = true;
      // Under --wait the sent-confirmation is normally skipped (the reply follows),
      // but it must still print when nothing will follow it: with --file the staging
      // result prints next regardless, and a recipient that isn't a mind will never
      // reply — in both cases the confirmation is the only word the sender gets that
      // the message went out (#691, #500).
      if (data.held || !flags.wait || flags.file || !waitMindName) {
        printSendResult(data);
      } else {
        printSendAdvisories(data);
      }
      // The daemon just said nothing will answer — don't block --wait on a reply
      // that will never come.
      if (data.spirit === "unavailable") spiritUnavailable = true;
    } else if (!parsed.isDM && parsed.platform === "volute") {
      // Bare names without # are ambiguous — require explicit sigil
      if (!parsed.identifier.startsWith("#")) {
        console.error(
          `Mind "${parsed.identifier}" not found.\n` +
            `  To send a DM:      volute chat send @${parsed.identifier} "..."\n` +
            `  To send to channel: volute chat send "#${parsed.identifier}" "..."`,
        );
        process.exit(1);
      }

      // For volute group channels (#general), look up by name and send
      const channelName = parsed.identifier.slice(1);
      const mindSelf = process.env.VOLUTE_MIND;

      // Look up channel conversation ID
      const channelRes = await daemonFetch(`/api/v1/channels/${encodeURIComponent(channelName)}`);
      if (!channelRes.ok) {
        console.error(`Channel "${channelName}" not found. Create it first or check the name.`);
        process.exit(1);
      }
      const channelData = (await channelRes.json()) as {
        id: string;
        participants?: { username: string; userType: string }[];
      };

      // Find a participant mind to use as context for the chat API
      const mindParticipant = channelData.participants?.find((p) => isMindUser(p));
      const contextMind = mindSelf ?? mindParticipant?.username;
      if (!contextMind) {
        console.error("No mind is a member of this channel. A mind must join the channel first.");
        process.exit(1);
      }

      channelContextMind = contextMind;

      const sendRes = await daemonFetch("/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message ?? "",
          conversationId: channelData.id,
          images,
          sender: claimedSender,
          targetMind: contextMind,
        }),
      });
      if (!sendRes.ok) {
        const data = await sendRes.json().catch(() => ({ error: "Unknown error" }));
        console.error((data as { error: string }).error);
        process.exit(1);
      }
      let data: SendResult = {};
      try {
        data = (await sendRes.json()) as SendResult;
      } catch (err) {
        console.error(`Warning: could not read send response: ${(err as Error).message}`);
      }
      if (data.held) heldResponse = true;
      printSendResult(data);
    } else {
      // Non-volute targets (discord:..., slack:..., etc.) are no longer supported directly.
      // With the bridge architecture, minds send to volute channels and bridges handle external routing.
      console.error(
        `Direct sends to ${parsed.platform} channels are no longer supported.\n` +
          "Use bridge channel names instead (e.g. volute chat send @mind-name or #channel-name).\n" +
          "See: volute chat bridge --help",
      );
      process.exit(1);
    }

    // Stage the attached file only after the message has actually been sent, so a
    // failed send can't leave an orphaned file offer with no context (#691).
    if (flags.file) {
      if (heldResponse) {
        // A held send never posted — the mind is expected to re-send. Staging now
        // would strand the file (the message it belongs to isn't out); say so
        // explicitly so a revised re-send doesn't silently drop the attachment.
        console.log(
          "Your attached file was not staged — include --file <path> again when you re-send.",
        );
      } else {
        await stageAttachedFile(true);
      }
    }

    if (heldResponse || spiritUnavailable) {
      // Nothing will answer (stale-send hold, or the spirit can't exist) — don't wait.
    } else if (flags.wait && waitMindName) {
      if (!waitConversationId) {
        console.error("--wait requires a volute conversation (DM to a mind)");
        process.exit(1);
      }
      await waitForResponse(waitMindName, waitConversationId, flags.timeout ?? 120_000);
    } else if (flags.wait) {
      // The send already succeeded — there is simply no reply to follow. Exiting
      // non-zero here told a mind reading the exit code that its message had failed
      // (#500). Say what happened, on stdout, and finish cleanly.
      // `chat read` resolves its mind from --mind or VOLUTE_MIND, so a host running
      // this from their own shell needs the flag spelled out or the suggested
      // command exits 1 on them.
      const mindFlag =
        process.env.VOLUTE_MIND || !channelContextMind ? "" : ` --mind ${channelContextMind}`;
      console.log(
        parsed.isDM
          ? `Nothing to wait for — ${parsed.identifier} isn't a mind, so no reply will arrive ` +
              "here. Your message went out."
          : "Nothing to wait for — a channel post has no single reply to follow. Your message " +
              `went out; read the channel with: volute chat read "${parsed.identifier}"${mindFlag}`,
      );
    }
  },
});

export const run = cmd.execute;
