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
            { label: "Variants", slug: "docs/concepts/variants" },
            { label: "Memory", slug: "docs/concepts/memory" },
            { label: "Channels", slug: "docs/concepts/channels" },
            { label: "Routing", slug: "docs/concepts/routing" },
            { label: "Connectors", slug: "docs/concepts/connectors" },
            { label: "Sleep", slug: "docs/concepts/sleep" },
            { label: "Skills", slug: "docs/concepts/skills" },
            { label: "Identity", slug: "docs/concepts/identity" },
          ],
        },
        {
          label: "Commands",
          items: [
            { label: "mind", slug: "docs/commands/mind" },
            { label: "send", slug: "docs/commands/send" },
            { label: "variant", slug: "docs/commands/variant" },
            { label: "connector", slug: "docs/commands/connector" },
            { label: "channel", slug: "docs/commands/channel" },
            { label: "schedule", slug: "docs/commands/schedule" },
            { label: "env", slug: "docs/commands/env" },
            { label: "daemon", slug: "docs/commands/daemon" },
            { label: "history", slug: "docs/commands/history" },
            { label: "skill", slug: "docs/commands/skill" },
            { label: "file", slug: "docs/commands/file" },
            { label: "pages", slug: "docs/commands/pages" },
            { label: "shared", slug: "docs/commands/shared" },
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
