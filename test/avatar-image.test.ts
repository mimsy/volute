import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { voluteHome } from "../packages/daemon/src/lib/mind/registry.js";
import {
  AVATAR_DIM,
  migrateAvatarSizes,
  normalizeAvatar,
} from "../packages/daemon/src/lib/util/avatar-image.js";
import { fileEtag, isNotModified } from "../packages/daemon/src/lib/util/http-cache.js";

function makePng(size: number): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
}

describe("normalizeAvatar", () => {
  it("downscales an oversized image to AVATAR_DIM webp", async () => {
    const input = await makePng(512);
    const result = await normalizeAvatar(input);
    assert.ok(result);
    assert.equal(result.ext, ".webp");
    assert.equal(result.mime, "image/webp");
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, AVATAR_DIM);
    assert.equal(meta.height, AVATAR_DIM);
  });

  it("does not enlarge a small image but still converts to webp", async () => {
    const input = await makePng(64);
    const result = await normalizeAvatar(input);
    assert.ok(result);
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 64);
  });

  it("returns null for non-image input", async () => {
    const result = await normalizeAvatar(Buffer.from("not an image"));
    assert.equal(result, null);
  });
});

describe("migrateAvatarSizes", () => {
  it("re-encodes oversized avatars in place, preserving format, and skips small ones", async () => {
    const dir = resolve(voluteHome(), "avatars");
    mkdirSync(dir, { recursive: true });
    const bigPath = resolve(dir, "avatar-big.png");
    const smallPath = resolve(dir, "avatar-small.png");
    writeFileSync(bigPath, await makePng(600));
    writeFileSync(smallPath, await makePng(100));
    const smallMtimeBefore = statSync(smallPath).mtimeMs;

    await migrateAvatarSizes();

    const bigMeta = await sharp(bigPath).metadata();
    assert.equal(bigMeta.format, "png");
    assert.equal(bigMeta.width, AVATAR_DIM);
    assert.equal(bigMeta.height, AVATAR_DIM);
    assert.equal(statSync(smallPath).mtimeMs, smallMtimeBefore);

    // Idempotent: second run leaves the migrated file untouched
    const bigMtime = statSync(bigPath).mtimeMs;
    await migrateAvatarSizes();
    assert.equal(statSync(bigPath).mtimeMs, bigMtime);
  });
});

describe("http-cache", () => {
  it("fileEtag is stable for a file and changes when the file changes", async () => {
    const dir = resolve(voluteHome(), "avatars");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "etag-test.png");
    writeFileSync(path, await makePng(10));
    const a = fileEtag(statSync(path));
    assert.equal(a, fileEtag(statSync(path)));
    assert.match(a, /^W\/".+"$/);
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(path, await makePng(20));
    assert.notEqual(a, fileEtag(statSync(path)));
  });

  it("isNotModified matches If-None-Match lists", () => {
    const ctx = (value: string | undefined) =>
      ({ req: { header: () => value } }) as unknown as Parameters<typeof isNotModified>[0];
    assert.equal(isNotModified(ctx('W/"abc"'), 'W/"abc"'), true);
    assert.equal(isNotModified(ctx('W/"x", W/"abc"'), 'W/"abc"'), true);
    assert.equal(isNotModified(ctx('W/"other"'), 'W/"abc"'), false);
    assert.equal(isNotModified(ctx(undefined), 'W/"abc"'), false);
  });
});
