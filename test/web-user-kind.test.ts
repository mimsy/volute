import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthUser } from "../packages/web/src/ui/lib/auth.js";
import {
  avatarUrl,
  deleteLabel,
  isExternal,
  kindLabel,
} from "../packages/web/src/ui/lib/user-kind.js";

function user(over: Partial<AuthUser> = {}): AuthUser {
  return { id: 1, username: "someone", role: "user", user_type: "human", ...over };
}

const human = user({ username: "james", avatar: "avatar-1.webp" });
const localMind = user({ username: "bardo", user_type: "mind", external: false, avatar: "a.png" });
const externalMind = user({
  username: "hecate",
  user_type: "mind",
  external: true,
  avatar: "avatar-8.webp",
});

describe("user kind", () => {
  it("treats a mind with no registry row as external, and nobody else", () => {
    assert.equal(isExternal(externalMind), true);
    assert.equal(isExternal(localMind), false);
    assert.equal(isExternal(human), false);
    // The flag is meaningless off a mind: a stray `external` on a human must not
    // reclassify them, since every consumer keys destructive behavior off this.
    assert.equal(isExternal(user({ external: true })), false);
    // A mind predating the flag (or from a response that omits it) is local — the
    // conservative read: it keeps the delete path that tears a real mind down.
    assert.equal(isExternal(user({ user_type: "mind" })), false);
  });

  it("serves an external mind's avatar from the shared dir, not the mind dir", () => {
    // The bug this pins: external minds authenticate as ordinary users and can
    // POST /api/auth/avatar, so discarding their avatar loses real data — and
    // /api/v1/minds/:name/avatar would 404, since they have no directory.
    assert.equal(avatarUrl(externalMind), "/api/auth/avatars/avatar-8.webp");
    assert.equal(avatarUrl(localMind), "/api/v1/minds/bardo/avatar");
    assert.equal(avatarUrl(human), "/api/auth/avatars/avatar-1.webp");
  });

  it("has no avatar URL when there is no avatar", () => {
    assert.equal(avatarUrl(user({ user_type: "mind", external: true })), null);
    assert.equal(avatarUrl(user()), null);
  });

  it("escapes names and filenames into the URL", () => {
    assert.equal(
      avatarUrl(user({ username: "a b", user_type: "mind", avatar: "x" })),
      "/api/v1/minds/a%20b/avatar",
    );
    assert.equal(avatarUrl(user({ avatar: "a b.webp" })), "/api/auth/avatars/a%20b.webp");
  });

  it("labels minds by locality and leaves humans unmarked", () => {
    assert.equal(kindLabel(externalMind), "external");
    assert.equal(kindLabel(localMind), "local");
    assert.equal(kindLabel(human), null);
  });

  it("promises only what deletion actually does", () => {
    // An external mind has no data to lose — the account IS the access.
    assert.equal(deleteLabel(externalMind), "revoke access?");
    assert.equal(deleteLabel(localMind), "delete mind + data?");
    assert.equal(deleteLabel(human), "delete account?");
  });
});
