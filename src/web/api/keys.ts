import { mindDir, readRegistry } from "@volute/shared/registry";
import { Hono } from "hono";
import { getFingerprint, getPublicKey } from "../../lib/identity.js";

const app = new Hono()
  /** Look up a public key by fingerprint (used by minds for signature verification) */
  .get("/:fingerprint", (c) => {
    const fingerprint = c.req.param("fingerprint");

    for (const entry of readRegistry()) {
      try {
        const pubKey = getPublicKey(mindDir(entry.name));
        if (!pubKey) continue;
        if (getFingerprint(pubKey) === fingerprint) {
          return c.json({ publicKey: pubKey, mind: entry.name });
        }
      } catch {}
    }

    return c.json({ error: "Key not found" }, 404);
  });

export default app;
