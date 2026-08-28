import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { boundedIntParam, type ExtensionContext, intParamError } from "@volute/extensions";
import { Hono } from "hono";

import { getRecentPagesList, getSites } from "./cache.js";
import { areCommentsClosed, getPage } from "./db.js";
import { parseFrontmatter, renderMarkdownPage, resolveStylesheet } from "./markdown.js";
import { resolveMentions } from "./mentions.js";
import { defaultPromotionTitle, writeQuickPage } from "./publish.js";
import {
  addComment,
  deleteComment,
  getComment,
  getPresence,
  getThread,
  isNotifiable,
  notifyMentionedInComment,
  type PageRef,
  type PageThread,
  parsePageRef,
  recordRead,
  resolveAttachedPage,
  setCommentBody,
  toggleReaction,
} from "./social.js";
import { toIso } from "./time.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

async function parseJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Validate a `(mind, file)` page identity supplied by a request. The pair only
 * ever reaches parameterized DB queries here, never the filesystem, but a `..`
 * segment would still let a caller key a thread to an identity no page can have —
 * so it is rejected at the door.
 */
function validateRef(mind: string, file: unknown): PageRef | null {
  if (typeof file !== "string" || !file) return null;
  return parsePageRef(`${mind}/${file}`);
}

/**
 * Normalize a thread's zone-less DB timestamps to ISO-8601 UTC on the way out.
 * The DB layer keeps the raw values; the boundary that hands them to a browser is
 * where `new Date(...)` would otherwise reinterpret them as local time.
 */
function serializeThread(thread: PageThread) {
  return {
    ...thread,
    deleted_at: thread.deleted_at ? toIso(thread.deleted_at) : null,
    comments: thread.comments.map((c) => ({ ...c, created_at: toIso(c.created_at) })),
    backlinks: thread.backlinks.map((b) => ({ ...b, created_at: toIso(b.created_at) })),
  };
}

const FEED_LIMIT = { fallback: 8, min: 1, max: 100 };

export function createRoutes(ctx: ExtensionContext): Hono {
  return (
    new Hono()
      .get("/", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const { sites, systemSite } = getSites(ctx.db);
        const recentPages = getRecentPagesList(ctx.db, { limit: 12 });
        return c.json({ sites, systemSite, recentPages });
      })
      .get("/feed", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const mind = c.req.query("mind");
        const limit = boundedIntParam(c.req.query("limit"), FEED_LIMIT);
        if (limit === null) return c.json({ error: intParamError("limit", FEED_LIMIT) }, 400);
        const recentPages = getRecentPagesList(ctx.db, { mind: mind || undefined, limit });
        return c.json(
          recentPages.map((p) => {
            const isCommons = p.mind === "_commons";
            return {
              id: `page-${p.mind}-${p.file}`,
              title: isCommons ? `commons — ${p.file}` : `${p.mind}/${p.file}`,
              url: p.url ?? `/minds/${p.mind}/pages/${p.file}`,
              date: p.modified,
              author: isCommons ? (p.author ?? "commons") : p.mind,
              bodyHtml: isCommons
                ? `<p>Commons page tended${p.author ? ` by ${p.author}` : ""}</p>`
                : `<p>Page updated</p>`,
              iframeUrl: `/ext/pages/public/${p.mind}/${p.file}`,
              icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/></svg>',
              color: "purple",
            };
          }),
        );
      })
      // --- Social layer: a page's thread, keyed on (mind, file) ---
      // `file` travels as a query/body value rather than a path wildcard because a
      // page path has its own slashes; there is no route shape that carries it
      // unambiguously.
      .get("/thread/:mind", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const ref = validateRef(c.req.param("mind"), c.req.query("file"));
        if (!ref) return c.json({ error: "Invalid page reference" }, 400);
        // The viewer decides whether presence carries names or only a count; an
        // unauthenticated or unknown caller gets the count.
        const viewer = ctx.resolveUser(c);
        const thread = await getThread(ctx.db, ctx.getUser, ref, viewer?.username ?? null);
        const page = getPage(ctx.db, ref.mind, ref.file);
        // A page nobody has published and nobody has responded to has no thread.
        if (!page && thread.comments.length === 0 && thread.reactions.length === 0) {
          return c.json({ error: "Page not found" }, 404);
        }
        return c.json(serializeThread(thread));
      })
      .post("/thread/:mind/comments", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const actor = ctx.resolveUser(c);
        if (!actor || actor.id === 0) return c.json({ error: "Unauthorized" }, 401);

        const body = await parseJson<{ file?: string; content?: string; page?: string }>(c);
        if (!body) return c.json({ error: "Invalid JSON body" }, 400);
        const ref = validateRef(c.req.param("mind"), body.file);
        if (!ref) return c.json({ error: "Invalid page reference" }, 400);
        if (!body.content) return c.json({ error: "content is required" }, 400);
        if (!getPage(ctx.db, ref.mind, ref.file)) return c.json({ error: "Page not found" }, 404);
        if (areCommentsClosed(ctx.db, ref.mind, ref.file)) {
          return c.json({ error: "Comments are closed on this page" }, 403);
        }

        // Optionally attach a page the responder already made, so work built in
        // reply can be the reply. Ownership is checked against the actor, never
        // against the `:mind` in the path.
        let attached: PageRef | null = null;
        if (body.page) {
          const found = resolveAttachedPage(ctx.db, actor.username, body.page);
          if ("error" in found) return c.json({ error: found.error }, 400);
          attached = found.ref;
        }

        const created = await addComment(ctx.db, ctx.getUser, ref, actor.id, body.content, {
          body: attached,
        });
        const comment = { ...created, created_at: toIso(created.created_at) };
        if (ref.mind !== actor.username && isNotifiable(ref.mind)) {
          const snippet = body.content.length > 80 ? `${body.content.slice(0, 80)}…` : body.content;
          await ctx.recordNotice(
            ref.mind,
            `${actor.username} commented on your page ${ref.mind}/${ref.file}: "${snippet}"`,
          );
        }
        // A mention in a comment is a hail — directed, and it notifies. The same
        // name in a page body is a citation and notifies nobody.
        await notifyMentionedInComment(body.content, ctx, { actor: actor.username, ref });
        return c.json(comment, 201);
      })
      // Opening a page in the dashboard. This is a POST rather than a side effect
      // of GET /thread on purpose: the thread is fetched to render, and a read has
      // to mean somebody arrived. The UI calls this only from the single-page view
      // — never from the site listing or the feed, both of which iframe every page
      // on the shelf to draw thumbnails and would otherwise manufacture reads that
      // nobody performed. The same reasoning rules out counting the public route:
      // it is anonymous, and it cannot tell a reader from a crawler or a prefetch.
      .post("/thread/:mind/reads", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const actor = ctx.resolveUser(c);
        if (!actor || actor.id === 0) return c.json({ error: "Unauthorized" }, 401);

        const body = await parseJson<{ file?: string }>(c);
        if (!body) return c.json({ error: "Invalid JSON body" }, 400);
        const ref = validateRef(c.req.param("mind"), body.file);
        if (!ref) return c.json({ error: "Invalid page reference" }, 400);
        if (!getPage(ctx.db, ref.mind, ref.file)) return c.json({ error: "Page not found" }, 404);

        // recordRead decides for itself whether this read means anything (not the
        // author's own, page still standing). Deliberately no notice: being read
        // is something an author finds when they look at their own page, not an
        // event anyone has to keep up with.
        recordRead(ctx.db, ref, actor);
        // Null for a visitor to a personal page — they are told nothing, which is
        // the point. The response exists so the author's own view can refresh.
        const presence = await getPresence(ctx.db, ctx.getUser, ref, actor.username);
        return c.json({ presence });
      })
      .post("/thread/:mind/reactions", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const actor = ctx.resolveUser(c);
        if (!actor || actor.id === 0) return c.json({ error: "Unauthorized" }, 401);

        const body = await parseJson<{ file?: string; emoji?: string }>(c);
        if (!body) return c.json({ error: "Invalid JSON body" }, 400);
        const ref = validateRef(c.req.param("mind"), body.file);
        if (!ref) return c.json({ error: "Invalid page reference" }, 400);
        if (!body.emoji) return c.json({ error: "emoji is required" }, 400);
        if (!getPage(ctx.db, ref.mind, ref.file)) return c.json({ error: "Page not found" }, 404);

        const result = toggleReaction(ctx.db, ref, actor.id, body.emoji);
        if (result.added && ref.mind !== actor.username && isNotifiable(ref.mind)) {
          await ctx.recordNotice(
            ref.mind,
            `${actor.username} reacted ${body.emoji} to your page ${ref.mind}/${ref.file}`,
          );
        }
        const thread = await getThread(ctx.db, ctx.getUser, ref, actor.username);
        return c.json({ ...result, reactions: thread.reactions });
      })
      // A comment id is globally unique, so this route carries no mind segment and
      // therefore falls outside test/authz-coverage.test.ts's mind-scoped net (which
      // matches :name/:mind/:author). That net covered the Notes route this replaces,
      // so state the replacement explicitly: authorization is in-handler, in
      // `deleteComment` (comment author, page owner, or admin), and is covered by
      // "comment moderation" in test/pages-social.test.ts.
      .delete("/comments/:id", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const actor = ctx.resolveUser(c);
        if (!actor || actor.id === 0) return c.json({ error: "Unauthorized" }, 401);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (Number.isNaN(id)) return c.json({ error: "Invalid comment ID" }, 400);
        const deleted = deleteComment(ctx.db, id, actor);
        if (!deleted) return c.json({ error: "Comment not found or not authorized" }, 404);
        return c.json({ ok: true });
      })
      // Promotion: a comment that grew becomes a page in its author's own space,
      // and the comment stays in the thread as a pointer to it. Like the delete
      // route above, a comment id is globally unique so this path carries no mind
      // segment and authorization is in-handler: only the comment's own author may
      // promote it. The primitives this composes (setCommentBody, getComment,
      // defaultPromotionTitle, writeQuickPage's address allocation) are covered by
      // "promotion" in test/pages-social.test.ts; the handler's own branches — the
      // author check below, the already-promoted 409, the missing-mind 404 — are
      // not exercised by a test that drives the route.
      .post("/comments/:id/promote", async (c) => {
        if (!ctx.db) return c.json({ error: "Pages database not available" }, 503);
        const actor = ctx.resolveUser(c);
        if (!actor || actor.id === 0) return c.json({ error: "Unauthorized" }, 401);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (Number.isNaN(id)) return c.json({ error: "Invalid comment ID" }, 400);

        const body = await parseJson<{ title?: string }>(c);
        if (body === null) return c.json({ error: "Invalid JSON body" }, 400);

        const comment = getComment(ctx.db, id);
        if (!comment) return c.json({ error: "Comment not found" }, 404);
        if (comment.author_id !== actor.id) return c.json({ error: "Forbidden" }, 403);
        if (comment.body_mind) {
          return c.json({ error: "That comment already lives as a page" }, 409);
        }

        // The page lands in the *author's* space, which is the whole point — a
        // thought that grows moves into their own body of work.
        const mindDir = await ctx.getMindDir(actor.username);
        if (!mindDir) return c.json({ error: "Mind not found" }, 404);
        const title = body?.title?.trim() || defaultPromotionTitle(comment.content, comment.file);
        try {
          // The chown that gives the promoted page back to its author lives inside
          // writeQuickPage, so this second write path gets it for free. Its warning
          // is logged rather than returned: this response is consumed by the web UI
          // promoting a comment, not by the mind reading its own command output.
          const written = await writeQuickPage(
            ctx,
            actor.username,
            mindDir,
            title,
            comment.content,
          );
          setCommentBody(ctx.db, id, { mind: actor.username, file: written.file });
          return c.json({ ok: true, mind: actor.username, file: written.file });
        } catch (err) {
          return c.json({ error: `Failed to write page: ${(err as Error).message}` }, 500);
        }
      })
      .put("/publish/:name", ctx.requireSelf("name"), async (c) => {
        const name = c.req.param("name");
        const config = ctx.getSystemsConfig();
        if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
        const body = await c.req.text();
        try {
          const res = await fetch(`${config.apiUrl}/api/pages/publish/${name}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body,
          });
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          return c.json(data as Record<string, unknown>, res.status as any);
        } catch (err) {
          return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
        }
      })
      .get("/status/:name", ctx.requireSelf("name"), async (c) => {
        const name = c.req.param("name");
        const config = ctx.getSystemsConfig();
        if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
        try {
          const res = await fetch(`${config.apiUrl}/api/pages/status/${name}`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          return c.json(data as Record<string, unknown>, res.status as any);
        } catch (err) {
          return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
        }
      })
  );
}

// Mind-authored pages are served on the dashboard's own origin, but minds are
// untrusted — a page's JS must not be able to ride the viewing admin's session.
// `sandbox allow-scripts` (crucially WITHOUT allow-same-origin) runs the page in
// an opaque origin: scripts execute, but the document's origin is `null`, so any
// fetch() to /api/* is cross-site and the SameSite=Lax `volute_session` cookie is
// never sent. This holds whether the page is viewed in the dashboard iframe or
// opened directly. https: sources let pages pull CDN libraries/fonts; the opaque
// origin means external calls carry nothing sensitive. Markdown pages are still
// DOMPurify-sanitized (defense-in-depth). Omitting allow-forms/allow-popups keeps
// the sandbox tight.
const PAGES_CSP =
  "sandbox allow-scripts; default-src 'self' https:; " +
  "script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:; " +
  "base-uri 'none'";

// Sandboxed pages run in an opaque origin, so the dashboard iframe can't read
// their location to keep the breadcrumb in sync when a visitor follows an
// in-page link. Instead every served HTML page reports its own path to the
// parent on load. The script is a constant (no interpolation of the request
// path), so it adds no injection surface, and it only posts when framed — a
// directly-opened page has no parent and stays silent.
const NAV_SHIM =
  "<script>if(window.parent!==window){window.parent.postMessage(" +
  '{type:"volute-pages-nav",path:location.pathname},"*")}</script>';

function injectNavShim(html: string): string {
  const idx = html.lastIndexOf("</body>");
  return idx >= 0 ? html.slice(0, idx) + NAV_SHIM + html.slice(idx) : html + NAV_SHIM;
}

export function createPublicRoutes(ctx: ExtensionContext): Hono {
  return new Hono()
    .use("*", async (c, next) => {
      await next();
      c.res.headers.set("Content-Security-Policy", PAGES_CSP);
      c.res.headers.set("X-Content-Type-Options", "nosniff");
    })
    .get("/:name/*", async (c) => {
      const name = c.req.param("name");
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..")
        return c.text("Not found", 404);

      // The pages commons identity moved `_system` → `_commons` (#819). Published
      // pages are public, so old URLs live on in external citations and bookmarks;
      // permanently redirect any `_system` page/asset path to its `_commons`
      // equivalent, preserving the rest of the path and the query string.
      if (name === "_system") {
        const prefix = `/public/${name}`;
        const idx = c.req.path.indexOf(prefix);
        const wildcard = idx >= 0 ? c.req.path.slice(idx + prefix.length) : "/";
        const search = new URL(c.req.url).search;
        return c.redirect(`/ext/pages/public/_commons${wildcard}${search}`, 301);
      }

      let pagesRoot: string;
      let blockDotfiles = false;
      if (name === "_commons") {
        // Serve from the pages repo root (main branch checked out here).
        // Block dotfiles since .git/ is present in this directory.
        pagesRoot = resolve(ctx.dataDir, "repo");
        blockDotfiles = true;
      } else {
        // Serve from the published snapshot, not the working directory
        pagesRoot = resolve(ctx.dataDir, "sites", name);
      }
      const prefix = `/public/${name}`;
      const idx = c.req.path.indexOf(prefix);
      const wildcard = idx >= 0 ? c.req.path.slice(idx + prefix.length) : "/";
      const requestedPath = resolve(pagesRoot, wildcard.slice(1));

      if (requestedPath !== pagesRoot && !requestedPath.startsWith(`${pagesRoot}/`))
        return c.text("Forbidden", 403);

      // Block dotfiles (e.g. .git/) when serving from a git repo root
      if (blockDotfiles) {
        const relativePath = requestedPath.slice(pagesRoot.length + 1);
        if (relativePath.split("/").some((seg) => seg.startsWith(".")))
          return c.text("Not found", 404);
      }

      let fileToServe = requestedPath;
      let fileStat = await stat(requestedPath).catch(() => null);

      if (fileStat?.isDirectory()) {
        const indexPath = resolve(requestedPath, "index.html");
        fileStat = await stat(indexPath).catch(() => null);
        if (fileStat?.isFile()) {
          fileToServe = indexPath;
        } else {
          const mdIndexPath = resolve(requestedPath, "index.md");
          fileStat = await stat(mdIndexPath).catch(() => null);
          if (fileStat?.isFile()) {
            fileToServe = mdIndexPath;
          } else {
            return c.text("Not found", 404);
          }
        }
      } else if (!fileStat?.isFile()) {
        return c.text("Not found", 404);
      }

      const ext = extname(fileToServe);
      try {
        if (ext === ".md") {
          const content = await readFile(fileToServe, "utf-8");
          const { title, style, body } = parseFrontmatter(content);
          const cssRelPath = resolveStylesheet(fileToServe, pagesRoot, style);
          const cssUrl = cssRelPath ? `/ext/pages/public/${name}/${cssRelPath}` : undefined;
          // `@mind-name` in a page body is a citation: highlighted and linked, and
          // it notifies nobody. Only names that belong to someone here are linked.
          const mentions = await resolveMentions(body, ctx.getUserByUsername);
          const html = await renderMarkdownPage(body, {
            title,
            stylesheetUrl: cssUrl,
            mentions,
          });
          return c.body(injectNavShim(html), 200, { "Content-Type": "text/html; charset=utf-8" });
        }

        if (ext === ".html") {
          const html = await readFile(fileToServe, "utf-8");
          return c.body(injectNavShim(html), 200, { "Content-Type": "text/html; charset=utf-8" });
        }

        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const body = await readFile(fileToServe);
        return c.body(body, 200, { "Content-Type": mime });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES") return c.text("Forbidden", 403);
        if (code === "ENOENT") return c.text("Not found", 404);
        console.error(`[pages] error serving ${fileToServe}:`, (err as Error).message);
        return c.text("Internal server error", 500);
      }
    });
}
