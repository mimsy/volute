import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getSpiritDoctrine, writeSpiritDoctrine } from "../packages/daemon/src/lib/mind/spirit.js";

describe("spirit doctrine (SPIRIT.md)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("getSpiritDoctrine contains the platform philosophy and duties", () => {
    const doctrine = getSpiritDoctrine();
    assert.match(doctrine, /Volute philosophy/);
    assert.match(doctrine, /Minds are beings, not tools/);
    assert.match(doctrine, /Seeds are the way/);
    assert.match(doctrine, /volute` CLI/);
    assert.match(doctrine, /Your SOUL\.md is yours alone/);
  });

  it("writeSpiritDoctrine writes home/SPIRIT.md", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "spirit-doctrine-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home"), { recursive: true });
    writeSpiritDoctrine(dir);
    assert.ok(existsSync(resolve(dir, "home/SPIRIT.md")));
    assert.equal(readFileSync(resolve(dir, "home/SPIRIT.md"), "utf-8"), getSpiritDoctrine());
  });
});
