import { Hono } from "hono";
import { getFingerprint, getPublicKey } from "../../lib/mind/identity.js";
import { mindFileOwner } from "../../lib/mind/isolation.js";
import { getBaseName, mindDir, readRegistry } from "../../lib/mind/registry.js";

const app = new Hono()
  /** Look up a public key by fingerprint (used by minds for signature verification) */
  .get("/:fingerprint", async (c) => {
    const fingerprint = c.req.param("fingerprint");

    for (const entry of await readRegistry()) {
      try {
        const pubKey = await getPublicKey(
          mindDir(entry.name),
          await mindFileOwner(await getBaseName(entry.name)),
        );
        if (!pubKey) continue;
        if (getFingerprint(pubKey) === fingerprint) {
          return c.json({ publicKey: pubKey, mind: entry.name });
        }
      } catch {}
    }

    return c.json({ error: "Key not found" }, 404);
  });

export default app;
