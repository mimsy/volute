import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
} from "../packages/daemon/src/lib/template/template.js";

describe("template composition", () => {
  const templatesRoot = findTemplatesRoot();

  it("composes claude template with all expected files", () => {
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    try {
      // Base files (real names — the composed template ships gitignore, not
      // .gitignore, because npm pack drops files named .gitignore)
      assert.ok(existsSync(resolve(composedDir, "gitignore")));
      assert.ok(!existsSync(resolve(composedDir, ".gitignore")));
      assert.ok(existsSync(resolve(composedDir, "biome.json")));
      assert.ok(existsSync(resolve(composedDir, "tsconfig.json")));
      assert.ok(existsSync(resolve(composedDir, "home/.config/config.json")));

      // Base shared source
      assert.ok(existsSync(resolve(composedDir, "src/lib/types.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/logger.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/volute-server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/format-prefix.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/startup.ts")));
      // Base router + file handler
      assert.ok(existsSync(resolve(composedDir, "src/lib/router.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/file-handler.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/routing.ts")));

      // Template-specific source
      assert.ok(existsSync(resolve(composedDir, "src/server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/agent.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/message-channel.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/hooks/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/hooks/pre-compact.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/hooks/identity-reload.ts")));

      // Init files (from base + template)
      assert.ok(existsSync(resolve(composedDir, ".init/SOUL.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MEMORY.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/CLAUDE.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/memory/journal/.gitkeep")));
      assert.ok(existsSync(resolve(composedDir, ".init/.local/hooks/startup-context.ts")));
      assert.ok(
        existsSync(resolve(composedDir, ".init/.local/hooks/pre-prompt/session-activity.ts")),
      );
      assert.ok(existsSync(resolve(composedDir, ".init/.claude/settings.json")));

      // Skills no longer bundled in template (managed via shared pool)
      assert.ok(!existsSync(resolve(composedDir, "_skills")), "_skills should not exist");

      // Manifest should be removed from composed output
      assert.ok(!existsSync(resolve(composedDir, "volute-template.json")));

      // Home dir with VOLUTE.md
      assert.ok(existsSync(resolve(composedDir, "home/VOLUTE.md")));

      // Package.json (real name, {{name}} not yet substituted)
      assert.ok(existsSync(resolve(composedDir, "package.json")));

      // Manifest shape: rename now covers only the gitignore workaround
      assert.deepEqual(Object.keys(manifest.rename).sort(), ["gitignore"]);
      assert.equal(manifest.rename.gitignore, ".gitignore");
      assert.ok(manifest.substitute.includes("package.json"));
      assert.ok(manifest.substitute.includes(".init/SOUL.md"));
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("composes pi template with all expected files", () => {
    const { composedDir } = composeTemplate(templatesRoot, "pi");
    try {
      // Base files
      assert.ok(existsSync(resolve(composedDir, "gitignore")));
      assert.ok(existsSync(resolve(composedDir, "tsconfig.json")));

      // Base shared source
      assert.ok(existsSync(resolve(composedDir, "src/lib/types.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/logger.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/volute-server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/format-prefix.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/startup.ts")));
      // Base router + file handler
      assert.ok(existsSync(resolve(composedDir, "src/lib/router.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/file-handler.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/routing.ts")));

      // Template-specific source
      assert.ok(existsSync(resolve(composedDir, "src/server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/agent.ts")));

      // No claude-template-specific files
      assert.ok(!existsSync(resolve(composedDir, "src/lib/message-channel.ts")));
      assert.ok(!existsSync(resolve(composedDir, "src/lib/hooks")));
      assert.ok(!existsSync(resolve(composedDir, "src/lib/agent-sessions.ts")));

      // Init files
      assert.ok(existsSync(resolve(composedDir, ".init/SOUL.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MEMORY.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MINDS.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/routes.json")));
      assert.ok(
        existsSync(resolve(composedDir, ".init/.local/hooks/pre-prompt/session-activity.ts")),
      );

      // Pi overrides home/.config/config.json with its own default model
      assert.ok(existsSync(resolve(composedDir, "home/.config/config.json")));

      // Skills no longer bundled in template (managed via shared pool)
      assert.ok(!existsSync(resolve(composedDir, "_skills")), "_skills should not exist");
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("composes codex template with all expected files", () => {
    const { composedDir } = composeTemplate(templatesRoot, "codex");
    try {
      // Base files
      assert.ok(existsSync(resolve(composedDir, "gitignore")));
      assert.ok(existsSync(resolve(composedDir, "tsconfig.json")));

      // Base shared source
      assert.ok(existsSync(resolve(composedDir, "src/lib/types.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/logger.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/volute-server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/format-prefix.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/startup.ts")));
      // Base router + file handler
      assert.ok(existsSync(resolve(composedDir, "src/lib/router.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/file-handler.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/routing.ts")));

      // Template-specific source
      assert.ok(existsSync(resolve(composedDir, "src/server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/agent.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/content.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/session-store.ts")));

      // No claude-template-specific files
      assert.ok(!existsSync(resolve(composedDir, "src/lib/message-channel.ts")));
      assert.ok(!existsSync(resolve(composedDir, "src/lib/hooks")));

      // Init files
      assert.ok(existsSync(resolve(composedDir, ".init/SOUL.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MEMORY.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/AGENTS.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/routes.json")));
      assert.ok(
        existsSync(resolve(composedDir, ".init/.local/hooks/pre-prompt/session-activity.ts")),
      );

      // Codex overrides home/.config/config.json with its own defaults
      assert.ok(existsSync(resolve(composedDir, "home/.config/config.json")));

      // Skills no longer bundled in template (managed via shared pool)
      assert.ok(!existsSync(resolve(composedDir, "_skills")), "_skills should not exist");
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("substitutes {{name}} in the composed package.json (idempotently)", () => {
    // Regression: composeTemplate() ships a real package.json but with {{name}}
    // still unsubstituted (substitution normally happens in copyTemplateToDir).
    // Callers like syncSpiritTemplate that read composedDir/package.json directly
    // must render it first, so a template switch actually updates deps / npm.
    const { composedDir } = composeTemplate(templatesRoot, "pi");
    try {
      const raw = readFileSync(resolve(composedDir, "package.json"), "utf-8");
      assert.ok(raw.includes("{{name}}"), "composed package.json ships {{name}} unsubstituted");

      const pkgPath = renderComposedPackageJson(composedDir, "volute");
      assert.ok(pkgPath && existsSync(pkgPath), "package.json should be rendered");

      const rendered = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(rendered);
      assert.equal(pkg.name, "volute", "{{name}} should be substituted");
      assert.ok(!rendered.includes("{{name}}"), "no placeholder should remain");
      assert.ok(
        pkg.dependencies["@earendil-works/pi-coding-agent"],
        "pi template deps should be present",
      );

      // Idempotent: rendering again yields identical content.
      renderComposedPackageJson(composedDir, "volute");
      assert.equal(readFileSync(pkgPath, "utf-8"), rendered, "second render is a no-op");
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("templates ship gitignore under a dot-less name so npm pack can't drop it", () => {
    // npm pack silently drops files named .gitignore from the published tarball,
    // so the template must ship it as `gitignore` and rename at scaffold time —
    // otherwise npm-installed minds get no .gitignore and auto-commit SDK runtime
    // state (session transcripts, .mind/, node_modules/) — the bug #656 fixed.
    assert.ok(
      existsSync(resolve(templatesRoot, "_base", "gitignore")),
      "templates/_base/gitignore (dot-less) must exist",
    );
    assert.ok(
      !existsSync(resolve(templatesRoot, "_base", ".gitignore")),
      "templates/_base must not ship a real .gitignore (npm pack drops it)",
    );
    for (const template of ["claude", "pi", "codex"]) {
      const manifest = JSON.parse(
        readFileSync(resolve(templatesRoot, template, "volute-template.json"), "utf-8"),
      );
      assert.equal(
        manifest.rename.gitignore,
        ".gitignore",
        `${template} manifest must rename gitignore → .gitignore`,
      );
    }
  });
});
