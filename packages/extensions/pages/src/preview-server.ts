/**
 * The origin a preview renders from.
 *
 * A preview used to hand chromium a `file://` URL for the mind's draft. Chromium
 * runs as the daemon there — root under user isolation — and a page can pull
 * another local file into its own rendering without any script at all: an
 * `<iframe>`, an `<object>`, or an `<img>` whose source is a symlink. The file
 * contents then appear in the screenshot the mind opens. Nothing in the page's own
 * markup has to name a `file:` URL for that to work, so checking the *target* of
 * the preview (#964) was necessary and not sufficient, and the usual mitigations
 * do not apply: `--disable-file-system` governs the FileSystem API rather than
 * `file:` loading, a `file://` load of the mind's own HTML cannot be given a CSP,
 * and a `data:` URL cannot resolve the page's own relative stylesheet.
 *
 * So the fix is to stop rendering from a file origin. For the length of one render
 * this serves the mind's real pages directory over loopback, and every request —
 * the page, its CSS, its images, anything an iframe reaches for — is resolved and
 * proven to land inside that directory before a byte is read. One boundary now
 * covers every load the page performs, instead of a check on the one path the
 * daemon opened itself.
 *
 * Two deliberate choices worth stating:
 *
 * - **A hard link is refused**, unlike an internal symlink. The distinction is
 *   what each one proves: an internal symlink is demonstrably a second route to a
 *   file inside the tree, while a hard link proves nothing about the inode it
 *   names — on macOS a mind can hardlink a file it cannot itself read.
 * - **An internal symlink is served.** This is not the published-page rule, where
 *   any link at all is refused (#1077). What is being contained here is the
 *   *daemon's* reach, and the tree being served is one the mind can already read
 *   in full, so a link that stays inside it escalates nothing. Refusing one would
 *   only break a draft that legitimately uses it.
 * - **Dotfiles are served.** The markdown path writes its rendered scratch as a
 *   dotfile so a concurrent publish won't snapshot it, and it has to be fetchable.
 *   The one dotfile of consequence under `home/pages` is `_system/.git`, a
 *   `gitdir:` pointer whose actual objects live outside the tree and are therefore
 *   refused by containment like anything else.
 *
 * Everything is mounted under a per-render prefix rather than at the root, and it
 * is worth being exact about what that buys, because it is less than it looks.
 * The listener is on loopback, which every process on the host can reach — minds
 * included, since they keep loopback to talk to the daemon — and drafts are
 * precisely the pages a mind has not decided to publish. The prefix raises the
 * cost of *guessing* a live render's URL from nothing, and that is all. It is not
 * a secret: it has to appear in the browser's command line as the URL, and
 * `/proc/<pid>/cmdline` is world-readable on Linux and in Docker. Another local
 * process that can list processes during the render can read this mind's drafts.
 *
 * The daemon controls the browser's argv and cannot remove the URL from it, so
 * this does not close by tightening the prefix. It would need an authenticated
 * origin, and node's TCP sockets expose no peer credentials to check against
 * (`getpeereid` is a unix-socket facility, and chromium cannot fetch one). What
 * *is* fixed is everything around it: the browser's scratch directory names no
 * longer carry the prefix, so `ls /tmp` on a shared 1777 directory no longer
 * hands it over, and the window is one render rather than the daemon's life.
 *
 * Residual, stated rather than engineered around: resolving a path and then
 * opening it is not atomic, so a directory swapped mid-request could still be
 * followed. That is the same window `resolvePagesWrite` documents, on a tree the
 * mind owns; closing it properly would need `O_NOFOLLOW` opens.
 */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { isMultiplyLinkedFile, within } from "./ownership.js";
import { MIME_TYPES, PAGES_CSP } from "./serving.js";

export type PreviewServer = {
  /** The loopback port the render should fetch from. */
  port: number;
  /** Prefix every URL path must carry. Unguessable, and the only mounted path. */
  token: string;
  /** Stop listening and drop every connection. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * Serve `root` on 127.0.0.1 under `/<token>/` until `close()` is called.
 *
 * `root` must already be a real path — the caller has one from `resolvePagesDir`,
 * and resolving it here as well would hide the case where it is not what it
 * claims to be.
 */
export async function startPreviewServer(root: string, token: string): Promise<PreviewServer> {
  const realRoot = realpathSync(root);
  const prefix = `/${token}/`;

  const server = createServer((req, res) => {
    void serve(realRoot, prefix, req.url ?? "/", res).catch(() => {
      // A socket that died mid-write is the client's business, not ours. Nothing
      // here may throw into the server's error handler and take the render down.
      res.destroy();
    });
  });

  // One listener, attached before `listen` and never removed. An `error` event
  // with nothing listening is *thrown*, so a server that later runs out of file
  // descriptors accepting a connection would take the whole daemon down in the
  // middle of somebody's preview. Attaching for the bind and detaching after
  // leaves exactly that gap, so the handler is permanent and the bind borrows it.
  let reportBindFailure: ((err: Error) => void) | null = null;
  server.on("error", (err) => {
    const fail = reportBindFailure;
    reportBindFailure = null;
    if (fail) return fail(err);
    console.warn(`[pages] preview server error: ${err.message}`);
  });

  await new Promise<void>((done, fail) => {
    reportBindFailure = fail;
    server.listen(0, "127.0.0.1", () => {
      reportBindFailure = null;
      done();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("preview server did not bind a port");
  }

  return { port: address.port, token, close: () => closeServer(server) };
}

/** Build the URL a browser should be pointed at for `relPath` under `root`. */
export function previewUrl(s: Pick<PreviewServer, "port" | "token">, relPath: string): string {
  // Segment-wise, not `encodeURI`: a page called `q&a #1.html` is a legal filename,
  // and `encodeURI` leaves `#` and `?` intact, which would cut the path short.
  const encoded = relPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `http://127.0.0.1:${s.port}/${s.token}/${encoded}`;
}

async function serve(
  realRoot: string,
  prefix: string,
  url: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const notFound = (): void => {
    // Guarded because a 200 is written the moment the file opens; anything that
    // fails after that point must drop the connection rather than try to send a
    // second set of headers over the first.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  };

  // Everything lives under the token. A request that does not carry it is not a
  // subresource of this render, whoever sent it.
  const pathOnly = url.split("?")[0].split("#")[0];
  if (!pathOnly.startsWith(prefix)) return notFound();

  let rel: string;
  try {
    rel = decodeURIComponent(pathOnly.slice(prefix.length));
  } catch {
    // A malformed escape is not a path. Refusing beats guessing at what was meant.
    return notFound();
  }

  // `"." +` before resolving: a decoded path that begins with `/` is absolute, and
  // `resolve(root, "/etc/passwd")` returns `/etc/passwd`. Containment below would
  // still catch it, but the first line of defence should not need the second.
  const requested = resolve(realRoot, `.${rel.startsWith("/") ? rel : `/${rel}`}`);

  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    return notFound();
  }
  if (!within(realRoot, real)) return notFound();

  // Open *before* anything is written. Answering 200 off a `stat` and only then
  // reaching for the file means an open that fails — the file deleted in between,
  // a mode the daemon cannot read — is delivered as a successful empty page, and
  // an empty page is a worse answer than "not found" because it looks like the
  // page rendered. With the handle in hand, every failure below is still a clean
  // 404.
  const handle = await open(real, "r").catch(() => null);
  if (!handle) return notFound();
  try {
    // `fstat`, not another `stat` on the path: this describes the inode actually
    // opened, so the length is the length of what will be sent and the link count
    // is the link count of what will be read.
    const info = await handle.stat();
    // No directory listings, and no index fallback either: a preview renders one
    // named page, and the browser is given that page's own URL.
    if (!info.isFile()) return notFound();
    // Containment asks *where* a name lives, and a hard link's answer is honestly
    // "here" — it is a second name for an inode, not a pointer out of the tree. So
    // it passes every check above and has to be refused on its own terms (#1089).
    if (isMultiplyLinkedFile(info)) return notFound();

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(real)] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      // The same rules the published page will be served under. A preview exists
      // to show what publishing will look like, and the sandbox is not cosmetic:
      // it puts the page in an opaque origin, where a same-origin `fetch` of its
      // own data file fails. Without this, a page previews green and publishes
      // broken.
      "Content-Security-Policy": PAGES_CSP,
      "X-Content-Type-Options": "nosniff",
    });
    // `pipeline`, not `pipe`: `pipe` leaves the read stream open when the other
    // end goes away, and the other end going away is the normal case here — a
    // render that timed out is killed, and `closeAllConnections()` drops its
    // sockets mid-response. With `pipe` that leaks a descriptor per aborted
    // response, and the await above it never settles.
    await pipeline(handle.createReadStream({ autoClose: false }), res).catch(() => {
      // A client that left is not an error worth reporting; the response is over
      // either way.
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * `closeAllConnections` before `close`: a browser leaves keep-alive sockets open,
 * and `close` alone waits for every one of them. On the path where the render
 * timed out and the browser was killed that wait is the difference between a
 * `finally` that returns and one that hangs for the keep-alive window.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}
