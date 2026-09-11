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
 * Everything is mounted under a per-render token rather than at the root. The
 * listener is on loopback, but loopback is reachable by every process on the host,
 * minds included — they keep it to talk to the daemon. Drafts are precisely the
 * pages a mind has not decided to publish, and an unguessable prefix keeps the
 * render window from being a way to read them.
 *
 * Residual, stated rather than engineered around: resolving a path and then
 * opening it is not atomic, so a directory swapped mid-request could still be
 * followed. That is the same window `resolvePagesWrite` documents, on a tree the
 * mind owns; closing it properly would need `O_NOFOLLOW` opens.
 */
import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";

import { MIME_TYPES } from "./mime.js";
import { within } from "./ownership.js";

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

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
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
  const notFound = () => {
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

  const info = await stat(real).catch(() => null);
  // No directory listings, and no index fallback either: a preview renders one
  // named page, and the browser is given that page's own URL.
  if (!info?.isFile()) return notFound();

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(real)] ?? "application/octet-stream",
    "Content-Length": String(info.size),
  });
  await new Promise<void>((done) => {
    const stream = createReadStream(real);
    stream.on("error", () => {
      res.destroy();
      done();
    });
    stream.on("end", done);
    stream.pipe(res);
  });
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
