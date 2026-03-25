// @ts-check

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://psamiton.github.io",
  base: "/volute",
  integrations: [
    starlight({
      title: "Volute",
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/psamiton/volute" }],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [{ label: "Quickstart", slug: "docs" }],
        },
        {
          label: "Concepts",
          items: [
            { label: "Minds", slug: "docs/concepts/minds" },
            { label: "Seeds", slug: "docs/concepts/seeds" },
            { label: "Variants", slug: "docs/concepts/variants" },
            { label: "Memory", slug: "docs/concepts/memory" },
            { label: "Channels", slug: "docs/concepts/channels" },
            { label: "Bridges", slug: "docs/concepts/connectors" },
            { label: "Routing", slug: "docs/concepts/routing" },
            { label: "Sleep", slug: "docs/concepts/sleep" },
            { label: "Dreaming", slug: "docs/concepts/dreaming" },
            { label: "Skills", slug: "docs/concepts/skills" },
            { label: "Extensions", slug: "docs/concepts/extensions" },
            { label: "Identity", slug: "docs/concepts/identity" },
          ],
        },
        {
          label: "Commands",
          items: [
            { label: "setup", slug: "docs/commands/setup" },
            { label: "mind", slug: "docs/commands/mind" },
            { label: "seed", slug: "docs/commands/seed" },
            { label: "send", slug: "docs/commands/send" },
            { label: "chat", slug: "docs/commands/chat" },
            { label: "variant", slug: "docs/commands/variant" },
            { label: "schedule", slug: "docs/commands/schedule" },
            { label: "env", slug: "docs/commands/env" },
            { label: "config", slug: "docs/commands/config" },
            { label: "skill", slug: "docs/commands/skill" },
            { label: "daemon", slug: "docs/commands/daemon" },
            { label: "extension", slug: "docs/commands/extension" },
            { label: "systems", slug: "docs/commands/systems" },
            { label: "notes", slug: "docs/commands/notes" },
            { label: "pages", slug: "docs/commands/pages" },
          ],
        },
        {
          label: "Deployment",
          slug: "docs/deployment",
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
