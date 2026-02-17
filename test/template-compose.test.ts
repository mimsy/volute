import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { composeTemplate, findTemplatesRoot } from "../src/lib/template.js";

describe("template composition", () => {
  const templatesRoot = findTemplatesRoot();

  it("composes agent-sdk template with all expected files", () => {
    const { composedDir, manifest } = composeTemplate(templatesRoot, "agent-sdk");
    try {
      // Base files
      assert.ok(existsSync(resolve(composedDir, ".gitignore")));
      assert.ok(existsSync(resolve(composedDir, "biome.json.tmpl")));
      assert.ok(existsSync(resolve(composedDir, "tsconfig.json")));
      assert.ok(existsSync(resolve(composedDir, "home/.config/config.json.tmpl")));

      // Base shared source
      assert.ok(existsSync(resolve(composedDir, "src/lib/types.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/logger.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/volute-server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/format-prefix.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/startup.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/session-monitor.ts")));

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
      assert.ok(existsSync(resolve(composedDir, "src/lib/hooks/session-context.ts")));

      // Init files (from base + template)
      assert.ok(existsSync(resolve(composedDir, ".init/SOUL.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MEMORY.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/CLAUDE.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/memory/journal/.gitkeep")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/hooks/startup-context.sh")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/scripts/session-reader.ts")));
      assert.ok(existsSync(resolve(composedDir, ".init/.claude/settings.json")));

      // Skills mapped to skillsDir
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "volute-agent/SKILL.md")));
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "memory/SKILL.md")));
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "sessions/SKILL.md")));
      assert.ok(!existsSync(resolve(composedDir, "_skills")), "_skills should be removed");

      // Manifest should be removed from composed output
      assert.ok(!existsSync(resolve(composedDir, "volute-template.json")));

      // Home dir with VOLUTE.md
      assert.ok(existsSync(resolve(composedDir, "home/VOLUTE.md")));

      // Package.json template
      assert.ok(existsSync(resolve(composedDir, "package.json.tmpl")));

      // Manifest shape
      assert.deepEqual(Object.keys(manifest.rename).sort(), [
        "biome.json.tmpl",
        "home/.config/config.json.tmpl",
        "package.json.tmpl",
      ]);
      assert.ok(manifest.substitute.includes("package.json"));
      assert.ok(manifest.substitute.includes(".init/SOUL.md"));
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("composes pi template with all expected files", () => {
    const { composedDir, manifest } = composeTemplate(templatesRoot, "pi");
    try {
      // Base files
      assert.ok(existsSync(resolve(composedDir, ".gitignore")));
      assert.ok(existsSync(resolve(composedDir, "tsconfig.json")));

      // Base shared source
      assert.ok(existsSync(resolve(composedDir, "src/lib/types.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/logger.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/volute-server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/auto-commit.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/format-prefix.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/startup.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/session-monitor.ts")));

      // Base router + file handler
      assert.ok(existsSync(resolve(composedDir, "src/lib/router.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/file-handler.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/routing.ts")));

      // Template-specific source
      assert.ok(existsSync(resolve(composedDir, "src/server.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/agent.ts")));
      assert.ok(existsSync(resolve(composedDir, "src/lib/session-context-extension.ts")));

      // No agent-sdk-specific files
      assert.ok(!existsSync(resolve(composedDir, "src/lib/message-channel.ts")));
      assert.ok(!existsSync(resolve(composedDir, "src/lib/hooks")));
      assert.ok(!existsSync(resolve(composedDir, "src/lib/agent-sessions.ts")));

      // Init files
      assert.ok(existsSync(resolve(composedDir, ".init/SOUL.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/MEMORY.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/AGENTS.md")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/routes.json")));
      assert.ok(existsSync(resolve(composedDir, ".init/.config/scripts/session-reader.ts")));

      // Pi overrides home/.config/config.json.tmpl with its own default model
      assert.ok(existsSync(resolve(composedDir, "home/.config/config.json.tmpl")));

      // Skills mapped to skillsDir
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "volute-agent/SKILL.md")));
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "memory/SKILL.md")));
      assert.ok(existsSync(resolve(composedDir, manifest.skillsDir, "sessions/SKILL.md")));
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });
});
