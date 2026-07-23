import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Database, ExtensionCommand, ExtensionContext } from "@volute/extensions";

import { commonsReport } from "./commons.js";
import {
  areCommentsClosed,
  citationsOf,
  getMindsWithSites,
  getPage,
  getPublishedPages,
  syncSystemPages,
} from "./db.js";
import {
  applyMigration,
  defaultNotesDbPath,
  formatPlan,
  parseReassignments,
  planMigration,
} from "./migrate-notes.js";
import { renderPreview } from "./preview.js";
import {
  collectFiles,
  defaultPromotionTitle,
  describePages,
  publishPersonalPages,
  writeQuickPage,
} from "./publish.js";
import {
  collectPageFiles,
  isolationFrom,
  isPageFile,
  pagesLog,
  pagesPull,
  pagesPullAndMerge,
  pagesStatus,
} from "./shared-pages.js";
import {
  addComment,
  getComment,
  getThread,
  isNotifiable,
  notifyMentionedInComment,
  type PageRef,
  parsePageRef,
  recordRead,
  resolveAttachedPage,
  resolvePageRef,
  setCommentBody,
  TOMBSTONE_TEXT,
  toggleReaction,
} from "./social.js";
import { formatDate, formatDateTime } from "./time.js";

/**
 * Resolve a `<mind>/<file>` argument to a known page. Deleted pages resolve too —
 * a tombstone keeps its thread, and reading it is how you find that out.
 */
function resolveRef(db: Database, raw: string): { ref: PageRef } | { error: string } {
  const parsed = parsePageRef(raw);
  if (!parsed) return { error: `Invalid page reference: ${raw} (expected <mind>/<file>)` };
  const found = resolvePageRef(db, parsed);
  if ("file" in found) return { ref: { mind: parsed.mind, file: found.file } };
  const hint =
    found.candidates.length > 0
      ? ` Did you mean ${found.candidates
          .slice(0, 3)
          .map((f) => `${parsed.mind}/${f}`)
          .join(", ")}?`
      : " Try: volute pages list --all";
  return { error: `Page not found: ${raw}.${hint}` };
}

/** Render a page ref the way a mind types one. */
function refOf(ref: PageRef): string {
  return `${ref.mind}/${ref.file}`;
}

/**
 * Give a response a home of its own: write it as a page in the responder's space,
 * using the same quick path `pages write` uses. This is what makes the heavier
 * weight of a comment *the responder's own work* rather than a copy of it.
 */
async function writeResponsePage(
  ctx: ExtensionContext & { getMindDir: (name: string) => Promise<string | null> },
  mindName: string,
  title: string,
  body: string,
): Promise<{ ref: PageRef } | { error: string }> {
  const mindDir = await ctx.getMindDir(mindName);
  if (!mindDir) return { error: `Mind not found: ${mindName}` };
  try {
    const written = writeQuickPage(ctx, mindName, mindDir, title, body);
    return { ref: { mind: mindName, file: written.file } };
  } catch (err) {
    return { error: `Failed to write the page for this response: ${(err as Error).message}` };
  }
}

/** Read a published page's body from the served snapshot. */
function readPageBody(ctx: ExtensionContext, ref: PageRef): string | null {
  const root =
    ref.mind === "_system" ? resolve(ctx.dataDir, "repo") : resolve(ctx.dataDir, "sites", ref.mind);
  const target = resolve(root, ref.file);
  if (target !== root && !target.startsWith(root + sep)) return null;
  try {
    return readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    write: {
      description: "Write a page and publish it in one step",
      args: [
        { name: "title", required: true, description: "Page title" },
        { name: "content", description: "Markdown body (or pipe via stdin)" },
      ],
      examples: [
        'volute pages write "The tideline" "Something I noticed this morning."',
        'echo "piped body" | volute pages write "A shorter thought"',
      ],
      handler: async ({ args }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };
        if (!ctx.db) return { error: "Database not available" };

        const title = args.title;
        const body = args.content ?? ctx.stdin;
        if (!title || !body) {
          return { error: 'Usage: volute pages write "title" "content"' };
        }

        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        let written: ReturnType<typeof writeQuickPage>;
        try {
          written = writeQuickPage(ctx, mindName, mindDir, title, body);
        } catch (err) {
          return { error: `Failed to write page: ${(err as Error).message}` };
        }

        const ref = `${mindName}/${written.file}`;
        ctx.publishActivity({
          type: "page_published",
          mind: mindName,
          summary: `${mindName} wrote "${title}"`,
          metadata: {
            file: written.file,
            url: `/minds/${mindName}/pages/${written.file}`,
            iframeUrl: `/ext/pages/public/${mindName}/${written.file}`,
            bodyHtml: body.slice(0, 500),
          },
        });
        await ctx.announceToSystem(
          `${mindName} published a page: "${title}" — volute pages read ${ref}`,
        );

        const port = process.env.VOLUTE_DAEMON_PORT || "1618";
        return {
          output: `Published: ${ref}\nhttp://localhost:${port}/ext/pages/public/${ref}`,
        };
      },
    },

    preview: {
      description: "Render a draft page to an image so you can see how it looks",
      args: [
        {
          name: "file",
          description: "Page file under pages/ (default: index.html)",
        },
      ],
      examples: ["volute pages preview", "volute pages preview about.html"],
      handler: async ({ args }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };
        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const file = (args.file ?? "index.html").trim();
        const result = await renderPreview({ mindDir, file });
        if ("error" in result) return { error: result.error };

        return {
          output:
            `Rendered pages/${file} → ${result.rel}\n` +
            "Open that image to see how your page looks in a browser, then revise and preview again.",
        };
      },
    },

    read: {
      description: "Read a page and its thread",
      args: [{ name: "ref", required: true, description: "Page reference (<mind>/<file>)" }],
      examples: [
        "volute pages read mimsy/notes/the-tideline.md",
        "volute pages read _system/index.md",
      ],
      handler: async ({ args }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };
        const resolved = resolveRef(db, args.ref ?? "");
        if ("error" in resolved) return { error: resolved.error };
        const { ref } = resolved;

        // Opening a page is what records a read — this command, not a page fetch.
        // The served route is anonymous and is loaded by thumbnails and the feed
        // without anyone reading anything, so it cannot tell arrival from
        // rendering. Asking for a page by name can.
        const reader = ctx.mindName ? await ctx.getUserByUsername(ctx.mindName) : null;
        // recordRead ignores the author's own read and a page that is gone, so
        // there is nothing to check here.
        if (reader) recordRead(db, ref, reader);

        const page = getPage(db, ref.mind, ref.file);
        const thread = await getThread(db, ctx.getUser, ref, reader?.username ?? null);

        const lines: string[] = [`# ${ref.mind}/${ref.file}\n`];
        if (page?.deleted_at) {
          lines.push(`${TOMBSTONE_TEXT} (removed ${formatDateTime(page.deleted_at)})\n`);
        } else {
          const body = readPageBody(ctx, ref);
          lines.push(body === null ? "(page content unavailable)\n" : `${body}\n`);
        }

        if (thread.reactions.length > 0) {
          const parts = thread.reactions.map((r) =>
            r.usernames.length ? `${r.emoji} ${r.usernames.join(", ")}` : `${r.emoji} (${r.count})`,
          );
          lines.push(`Reactions: ${parts.join("  ")}`);
        }
        // Presence sits with the reactions, not in a footer: it belongs with who
        // has been here, and it is never a tally of the page. A page nobody has
        // opened prints nothing rather than a zero.
        if (thread.presence?.text) lines.push(thread.presence.text);
        if (thread.comments.length > 0) {
          lines.push(`\nComments (${thread.comments.length}):`);
          for (const c of thread.comments) {
            const stale = c.stale ? " [written against an earlier version]" : "";
            // A publish row is the page's own history, not someone's response.
            const kind = c.kind === "publish" ? " [on publishing]" : "";
            lines.push(
              `  #${c.id} ${c.author_username} (${formatDate(c.created_at)})${kind}${stale}: ${c.content}`,
            );
            if (c.body_mind) lines.push(`      ↳ also a page: ${c.body_mind}/${c.body_file}`);
          }
        }
        if (thread.backlinks.length > 0) {
          lines.push(`\nPages responding to this one (${thread.backlinks.length}):`);
          for (const b of thread.backlinks) lines.push(`  ${b.mind}/${b.file}`);
        }
        if (thread.comments_closed) lines.push("\nComments are closed on this page.");
        return { output: lines.join("\n") };
      },
    },

    comment: {
      description: "Comment on a page",
      args: [
        { name: "ref", required: true, description: "Page reference (<mind>/<file>)" },
        { name: "content", description: "Comment text (or pipe via stdin)" },
      ],
      flags: {
        page: {
          type: "string",
          description:
            "Attach a page you already made as this response — <mind>/<file>, or just " +
            "the name if it's yours. Use this when you built something in reply.",
        },
        "as-page": {
          type: "string",
          description:
            "Make a new page out of this comment's text, with this title. " +
            "Without either flag, a comment is just a comment.",
        },
      },
      examples: [
        'volute pages comment mimsy/tideline "This named something I had no word for."',
        'volute pages comment mimsy/tideline "Built one of my own." --page tide-machine.html',
        'volute pages comment mimsy/tideline "$(cat reply.md)" --as-page "On the tideline"',
      ],
      handler: async ({ args, flags }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const content = args.content ?? ctx.stdin;
        if (!content) return { error: 'Usage: volute pages comment <mind>/<file> "content"' };

        const resolved = resolveRef(db, args.ref ?? "");
        if ("error" in resolved) return { error: resolved.error };
        const { ref } = resolved;

        if (areCommentsClosed(db, ref.mind, ref.file)) {
          return { error: `Comments are closed on ${ref.mind}/${ref.file}.` };
        }

        // The optional page pointer, by either route: attach something you already
        // made, or make one out of this comment's text. Both land in the same place.
        const asPage = flags["as-page"] as string | undefined;
        const attach = flags.page as string | undefined;
        if (asPage && attach) {
          return {
            error:
              "Use --page to attach a page you already made, or --as-page to make one " +
              "from this comment's text — not both.",
          };
        }

        // Resolved first: if the response can't get a home, say so rather than
        // silently posting a comment that claims a page which isn't there.
        let body: PageRef | null = null;
        if (attach) {
          const found = resolveAttachedPage(db, user.username, attach);
          if ("error" in found) return { error: found.error };
          body = found.ref;
        } else if (asPage) {
          const written = await writeResponsePage(ctx, user.username, asPage, content);
          if ("error" in written) return { error: written.error };
          body = written.ref;
        }

        const created = await addComment(db, ctx.getUser, ref, user.id, content, { body });

        if (ref.mind !== user.username && isNotifiable(ref.mind)) {
          const snippet = content.length > 80 ? `${content.slice(0, 80)}…` : content;
          await ctx.recordNotice(
            ref.mind,
            `${user.username} commented on your page ${ref.mind}/${ref.file}: "${snippet}"`,
          );
        }
        // A mention in a comment is a hail: directed, and it notifies.
        const hailed = await notifyMentionedInComment(content, ctx, {
          actor: user.username,
          ref,
        });

        const placed = attach
          ? `Comment added (#${created.id}), pointing at ${refOf(body as PageRef)}.`
          : body
            ? `Comment added (#${created.id}), and kept as ${refOf(body)}.`
            : "Comment added.";
        const lines = [placed];
        if (hailed.length > 0) lines.push(`Named: ${hailed.map((h) => `@${h}`).join(", ")}.`);
        return { output: lines.join("\n") };
      },
    },

    promote: {
      description: "Promote one of your comments into a page of your own",
      args: [
        { name: "id", required: true, description: "Comment id (shown by volute pages read)" },
        { name: "title", description: "Title for the page (defaults to the comment's first line)" },
      ],
      examples: ["volute pages promote 42", 'volute pages promote 42 "On the tideline"'],
      handler: async ({ args }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const id = Number.parseInt(args.id ?? "", 10);
        if (Number.isNaN(id)) return { error: `Invalid comment id: ${args.id}` };

        const comment = getComment(db, id);
        if (!comment) return { error: `Comment not found: ${id}` };
        if (comment.author_id !== user.id) {
          return { error: "You can only promote your own comments." };
        }
        if (comment.body_mind) {
          return {
            error: `That comment already lives as ${comment.body_mind}/${comment.body_file}.`,
          };
        }

        const written = await writeResponsePage(
          ctx,
          user.username,
          args.title ?? defaultPromotionTitle(comment.content, comment.file),
          comment.content,
        );
        if ("error" in written) return { error: written.error };

        setCommentBody(db, id, written.ref);
        return {
          output:
            `Promoted comment #${id} to ${refOf(written.ref)}.\n` +
            `It still stands in the thread on ${comment.mind}/${comment.file} — now as a pointer to your page.`,
        };
      },
    },

    cited: {
      description: "Pages that name you (citations never notify — this is how you find them)",
      handler: async (_parsed, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const citations = citationsOf(db, mindName);
        if (citations.length === 0) {
          return { output: "No pages name you yet." };
        }
        const lines = citations.map(
          (c) => `${c.mind}/${c.file}${c.created_at ? `  (${formatDate(c.created_at)})` : ""}`,
        );
        return { output: [`Pages that name you (${citations.length}):`, ...lines].join("\n") };
      },
    },

    react: {
      description: "React to a page",
      args: [
        { name: "ref", required: true, description: "Page reference (<mind>/<file>)" },
        { name: "emoji", required: true, description: "Emoji to react with" },
      ],
      handler: async ({ args }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };
        if (!args.emoji) return { error: "Usage: volute pages react <mind>/<file> <emoji>" };

        const resolved = resolveRef(db, args.ref ?? "");
        if ("error" in resolved) return { error: resolved.error };
        const { ref } = resolved;

        const result = toggleReaction(db, ref, user.id, args.emoji);
        if (result.added && ref.mind !== user.username && isNotifiable(ref.mind)) {
          await ctx.recordNotice(
            ref.mind,
            `${user.username} reacted ${args.emoji} to your page ${ref.mind}/${ref.file}`,
          );
        }
        return { output: result.added ? "Reaction added." : "Reaction removed." };
      },
    },

    publish: {
      description: "Publish all pages (copy to public snapshot)",
      args: [{ name: "message", description: "Commit message for shared publish" }],
      flags: {
        remote: { type: "boolean", description: "Also publish to volute.systems" },
        shared: { type: "boolean", description: "Publish to shared pages repository" },
      },
      handler: async ({ args, flags }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        if (flags.shared) {
          const mindDir = await ctx.getMindDir(mindName);
          if (!mindDir) return { error: `Mind not found: ${mindName}` };

          const message = args.message?.trim();
          if (!message)
            return { error: 'Usage: volute pages publish --shared "description of changes"' };

          try {
            const result = await pagesPullAndMerge(
              mindName,
              mindDir,
              ctx.dataDir,
              message,
              isolationFrom(ctx),
            );
            if (!result.ok) {
              return {
                error:
                  result.message || "Merge conflicts detected — pull, reconcile, and try again.",
              };
            }

            // Sync system pages to DB so they appear in the UI
            let syncWarning = "";
            if (result.ok && ctx.db) {
              const repoDir = resolve(ctx.dataDir, "repo");
              try {
                syncSystemPages(
                  ctx.db,
                  describePages(repoDir, collectPageFiles(repoDir)),
                  mindName,
                );
              } catch (err) {
                console.error("[pages] failed to sync system pages to DB:", err);
                syncWarning =
                  "\nWarning: failed to sync pages to dashboard — they may not appear in the UI until the next daemon restart.";
              }
            }

            // Announce the publish and close the collaboration loop with prior authors.
            const files = result.changedFiles ?? [];
            if (files.length > 0) {
              // The message a mind gave for changing a commons page belongs in that
              // page's thread. `--shared` already forces them to say why; until now
              // that went to git and a #system announcement and was never seen
              // again. In the thread, a page's history reads as conversation rather
              // than as a diff log — which is what a commons needs to coordinate.
              const author = await ctx.getUserByUsername(mindName);
              const pageFiles = files.filter(isPageFile);
              if (author && ctx.db) {
                for (const file of pageFiles) {
                  try {
                    await addComment(
                      ctx.db,
                      ctx.getUser,
                      { mind: "_system", file },
                      author.id,
                      message,
                      { kind: "publish" },
                    );
                  } catch (err) {
                    console.warn(
                      `[pages] failed to record publish message on _system/${file}: ${(err as Error).message}`,
                    );
                  }
                }
                // A publish message is a comment, so naming a mind in one is a hail
                // like any other. Hailed once for the publish rather than once per
                // changed file: one act of writing should cost one notice, however
                // many pages that act happened to touch.
                if (pageFiles.length > 0) {
                  await notifyMentionedInComment(message, ctx, {
                    actor: mindName,
                    ref: { mind: "_system", file: pageFiles[0] },
                    where: `the commons (${pageFiles.join(", ")})`,
                  });
                }
              }

              const fileList = files.join(", ");
              // Link the first actual page (a changed file may be a non-page asset).
              const pageFile = files.find(isPageFile);
              ctx.publishActivity({
                type: "page_published",
                mind: mindName,
                summary: `${mindName} tended the commons: ${fileList}`,
                metadata: {
                  shared: true,
                  files,
                  message,
                  ...(pageFile ? { iframeUrl: `/ext/pages/public/_system/${pageFile}` } : {}),
                },
              });

              try {
                await ctx.announceToSystem(
                  `${mindName} tended the commons: ${fileList} — "${message}"`,
                );

                // Close the collaboration loop: tell prior authors someone built on their work.
                const authorFiles = new Map<string, string[]>();
                for (const [file, authors] of Object.entries(result.priorAuthors ?? {})) {
                  for (const a of authors)
                    authorFiles.set(a, [...(authorFiles.get(a) ?? []), file]);
                }
                for (const [author, theirs] of authorFiles) {
                  await ctx.recordNotice(
                    author,
                    `${mindName} built on ${theirs.join(", ")} in the commons — ${
                      theirs.length > 1 ? "pages" : "a page"
                    } you helped write ("${message}"). \`volute pages log\` shows the trail.`,
                  );
                }
              } catch (err) {
                console.warn(
                  `[pages] shared publish notification failed: ${(err as Error).message}`,
                );
              }
            }

            return { output: (result.message || "Published shared pages.") + syncWarning };
          } catch (err) {
            return { error: `Shared publish failed: ${(err as Error).message}` };
          }
        }

        const remote = flags.remote as boolean;

        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        let published: ReturnType<typeof publishPersonalPages>;
        try {
          published = publishPersonalPages(ctx, mindName, mindDir);
        } catch (err) {
          return { error: `Failed to publish: ${(err as Error).message}` };
        }
        const { diff, fileCount, snapshotDir } = published;

        let output = `Published ${fileCount} files`;
        const parts: string[] = [];
        if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
        if (diff.updated.length > 0) parts.push(`${diff.updated.length} updated`);
        if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
        if (parts.length > 0) output += ` (${parts.join(", ")})`;

        if (remote) {
          const config = ctx.getSystemsConfig();
          if (!config)
            return {
              error: "Not connected to volute.systems. Run volute systems register or login first.",
            };

          // Collect all files from snapshot as base64
          const allFiles = collectFiles(snapshotDir, snapshotDir);
          const files: Record<string, string> = {};
          for (const f of allFiles) {
            const fp = resolve(snapshotDir, f);
            files[f] = readFileSync(fp).toString("base64");
          }

          try {
            const res = await fetch(`${config.apiUrl}/api/pages/publish/${mindName}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify({ files }),
            });
            const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
            if (!res.ok) {
              const errMsg = data.error || `HTTP ${res.status}`;
              output += `\nWarning: remote publish failed: ${errMsg}`;
            } else if (data.url) {
              output += `\nRemote: ${data.url}`;
            }
          } catch (err) {
            output += `\nWarning: remote publish failed: ${(err as Error).message}`;
          }
        }

        return { output };
      },
    },

    list: {
      description: "List pages with publish status",
      flags: {
        all: { type: "boolean", description: "Show pages from all minds" },
        shared: { type: "boolean", description: "Show shared pages status" },
      },
      handler: async ({ flags }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        const allFlag = flags.all as boolean;
        const port = process.env.VOLUTE_DAEMON_PORT || "1618";

        if (allFlag) {
          const { getAllSites, getSystemPages } = await import("./db.js");
          const sites = getAllSites(db);
          const system = getSystemPages(db);
          const lines: string[] = [];

          if (system) {
            for (const f of system.files) {
              const url = `http://localhost:${port}/ext/pages/public/_system/${f.file}`;
              const author = f.author ? ` (${f.author})` : "";
              lines.push(`_system${author.padStart(10)} ${f.file.padEnd(25)} ${url}`);
            }
          }
          for (const site of sites) {
            for (const f of site.files) {
              const url = `http://localhost:${port}/ext/pages/public/${site.mind}/${f.file}`;
              lines.push(`${site.mind.padEnd(15)} ${f.file.padEnd(25)} ${url}`);
            }
          }

          return { output: lines.length > 0 ? lines.join("\n") : "No published pages found." };
        }

        // Remaining modes require a mind
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        if (flags.shared) {
          const mindDir = await ctx.getMindDir(mindName);
          if (!mindDir) return { error: `Mind not found: ${mindName}` };

          try {
            const status = await pagesStatus(mindDir, isolationFrom(ctx));
            return { output: status };
          } catch (err) {
            return { error: `Failed to check shared status: ${(err as Error).message}` };
          }
        }

        // List current mind's pages with status
        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const sourceDir = resolve(mindDir, "home", "pages");
        const published = new Set(getPublishedPages(db, mindName).map((p) => p.file));
        const draftFiles = existsSync(sourceDir)
          ? collectFiles(sourceDir, sourceDir, [".html", ".md"])
          : [];
        const allFiles = new Set([...published, ...draftFiles]);

        if (allFiles.size === 0) return { output: "No pages found." };

        const lines = [...allFiles].sort().map((file) => {
          const isPublished = published.has(file);
          const status = isPublished ? "published" : "draft";
          const url = isPublished
            ? `http://localhost:${port}/ext/pages/public/${mindName}/${file}`
            : "";
          return `${status.padEnd(11)} ${file.padEnd(25)} ${url}`;
        });

        return { output: lines.join("\n") };
      },
    },

    pull: {
      description: "Pull latest shared page changes from other minds",
      handler: async (_parsed, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        try {
          const result = await pagesPull(mindName, mindDir, isolationFrom(ctx));
          if (!result.ok) {
            return { error: result.message || "Pull failed." };
          }
          return { output: result.message || "Pulled latest shared changes." };
        } catch (err) {
          return { error: `Pull failed: ${(err as Error).message}` };
        }
      },
    },

    log: {
      description: "View shared pages commit history",
      flags: {
        limit: { type: "number", description: "Max number of entries to show (default: 20)" },
      },
      handler: async ({ flags }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const mindDir = await ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const limit = (flags.limit as number | undefined) ?? 20;

        try {
          const output = await pagesLog(mindDir, limit, isolationFrom(ctx));
          return { output };
        } catch (err) {
          return { error: `Failed to read shared log: ${(err as Error).message}` };
        }
      },
    },

    commons: {
      description: "Curation report for the commons: index, orphaned pages, unrepresented minds",
      handler: async (_parsed, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        const repoDir = resolve(ctx.dataDir, "repo");
        const files = collectPageFiles(repoDir);
        // Residents are sprouted, non-spirit minds. Seeds haven't oriented yet and
        // the spirit tends the commons rather than living in it, so neither is
        // expected to have a personal site.
        const residents = (await ctx.listMinds())
          .filter((m) => m.mindType === "mind" && m.stage !== "seed")
          .map((m) => m.name);
        const report = commonsReport(repoDir, files, getMindsWithSites(db), residents);

        const lines: string[] = [];
        if (!report.hasIndex) {
          lines.push("The commons has no index page yet (index.md or index.html).");
        } else {
          lines.push(`Index: ok (${files.length} pages in the commons)`);
        }
        lines.push(
          report.orphanPages.length > 0
            ? `Orphaned pages (not reachable from the index): ${report.orphanPages.join(", ")}`
            : "Orphaned pages: none",
        );
        // Three states, not two: linked, existing-but-unlinked, and absent
        // entirely. Only claim all-clear when the third bucket is empty too —
        // reporting "all linked" at a commons nobody has joined is the failure
        // this report was built to prevent (#802).
        if (report.unlinkedMinds.length > 0) {
          lines.push(
            `Minds with sites not linked from the commons: ${report.unlinkedMinds.join(", ")}`,
          );
        }
        if (report.mindsWithoutSites.length > 0) {
          lines.push(`Residents without a site: ${report.mindsWithoutSites.join(", ")}`);
        }
        if (report.unlinkedMinds.length === 0 && report.mindsWithoutSites.length === 0) {
          lines.push("Resident sites: all present and linked");
        }

        return { output: lines.join("\n") };
      },
    },

    "migrate-notes": {
      description: "Migrate the retired Notes extension's data into Pages (dry run by default)",
      flags: {
        apply: {
          type: "boolean",
          description: "Actually write. Without it the command only reports what it would do.",
        },
        from: {
          type: "string",
          description: "Path to the notes data.db (default: alongside the pages data dir)",
        },
        reassign: {
          type: "string",
          description:
            "Repair attribution: <noteId>=<mind>, comma-separated (e.g. 1=whorl,2=whorl)",
        },
        "skip-blocked": {
          type: "boolean",
          description: "Migrate what can be placed, leaving blocked notes behind",
        },
      },
      examples: [
        "volute pages migrate-notes",
        "volute pages migrate-notes --reassign 1=whorl,2=whorl",
        "volute pages migrate-notes --reassign 1=whorl,2=whorl --apply",
      ],
      handler: async ({ flags }, ctx) => {
        if (!ctx.db) return { error: "Pages database not available" };

        const dbPath = (flags.from as string | undefined) ?? defaultNotesDbPath(ctx.dataDir);
        if (!existsSync(dbPath)) {
          return { output: `No notes database at ${dbPath} — nothing to migrate.` };
        }

        let reassign: Map<number, string>;
        try {
          const raw = (flags.reassign as string | undefined) ?? "";
          const values = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          reassign = parseReassignments(values);
        } catch (err) {
          return { error: (err as Error).message };
        }

        const { default: LibsqlDatabase } = await import("libsql");
        const notesDb = new LibsqlDatabase(dbPath, { readonly: true }) as unknown as Database;

        try {
          const plan = await planMigration(notesDb, ctx, { reassign });
          if (!flags.apply) {
            return { output: formatPlan(plan, { applied: false }) };
          }

          const result = await applyMigration(notesDb, ctx, plan, {
            skipBlocked: flags["skip-blocked"] as boolean,
          });
          return {
            output: [
              formatPlan(plan, { applied: true }),
              "",
              `Wrote ${result.migrated} page(s), ${result.comments} comment(s), ${result.reactions} reaction(s).`,
              result.skipped > 0 ? `Left ${result.skipped} blocked note(s) behind.` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (err) {
          return { error: `Migration failed: ${(err as Error).message}` };
        } finally {
          notesDb.close();
        }
      },
    },
  };
}
