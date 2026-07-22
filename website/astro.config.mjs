// @ts-check

import starlight from "@astrojs/starlight";
import svelte from "@astrojs/svelte";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://volute.dev",
  redirects: {
    "/migrate": "/minds/moving-in",
    "/docs/commands/send": "/docs/commands/chat",
    "/docs/commands/variant": "/docs/commands/mind",
    "/docs/commands/schedule": "/docs/commands/clock",
    "/docs/concepts/dreaming": "/docs/concepts/sleep",
  },
  integrations: [
    svelte(),
    starlight({
      title: "Volute",
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/psamiton/volute" }],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Quickstart", slug: "docs" },
            { label: "Web dashboard", slug: "docs/dashboard" },
            { label: "Deployment", slug: "docs/deployment" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Minds", slug: "docs/concepts/minds" },
            { label: "Seeds", slug: "docs/concepts/seeds" },
            { label: "Spirit", slug: "docs/concepts/spirit" },
            { label: "Variants", slug: "docs/concepts/variants" },
            { label: "Memory", slug: "docs/concepts/memory" },
            { label: "Sleep", slug: "docs/concepts/sleep" },
            { label: "Channels", slug: "docs/concepts/channels" },
            { label: "Bridges", slug: "docs/concepts/connectors" },
            { label: "Routing", slug: "docs/concepts/routing" },
            { label: "Skills", slug: "docs/concepts/skills" },
            { label: "Extensions", slug: "docs/concepts/extensions" },
            { label: "Identity", slug: "docs/concepts/identity" },
            { label: "Mind configuration", slug: "docs/reference/mind-config" },
          ],
        },
        {
          label: "Commands",
          items: [
            { label: "setup", slug: "docs/commands/setup" },
            { label: "mind", slug: "docs/commands/mind" },
            { label: "seed", slug: "docs/commands/seed" },
            { label: "chat", slug: "docs/commands/chat" },
            { label: "clock", slug: "docs/commands/clock" },
            { label: "skill", slug: "docs/commands/skill" },
            { label: "env", slug: "docs/commands/env" },
            { label: "config", slug: "docs/commands/config" },
            { label: "backup", slug: "docs/commands/backup" },
            { label: "daemon", slug: "docs/commands/daemon" },
            { label: "extension", slug: "docs/commands/extension" },
            { label: "systems", slug: "docs/commands/systems" },
            { label: "pages", slug: "docs/commands/pages" },
            { label: "plan", slug: "docs/commands/plan" },
          ],
        },
        {
          label: "API",
          slug: "docs/api",
        },
        {
          label: "Architecture",
          slug: "docs/architecture",
        },
      ],
    }),
  ],
});
