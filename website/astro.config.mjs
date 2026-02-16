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
            { label: "Agents", slug: "docs/concepts/agents" },
            { label: "Variants", slug: "docs/concepts/variants" },
            { label: "Memory", slug: "docs/concepts/memory" },
            { label: "Channels", slug: "docs/concepts/channels" },
            { label: "Routing", slug: "docs/concepts/routing" },
            { label: "Connectors", slug: "docs/concepts/connectors" },
          ],
        },
        {
          label: "Commands",
          autogenerate: { directory: "docs/commands" },
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
