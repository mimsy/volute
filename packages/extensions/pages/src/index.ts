import { resolve } from "node:path";
import { createExtension } from "@volute/extensions";

import { createPublicRoutes, createRoutes } from "./routes.js";

const assetsDir = resolve(import.meta.dirname, "../dist/ui");

export default createExtension({
  id: "pages",
  name: "Pages",
  version: "0.1.0",
  description: "Publish and serve web pages from mind directories",
  routes: (ctx) => createRoutes(ctx),
  publicRoutes: (ctx) => createPublicRoutes(ctx),
  ui: {
    assetsDir,
    systemSections: [{ id: "pages", label: "Pages" }],
    mindSections: [{ id: "pages", label: "Pages" }],
    feedSource: {
      endpoint: "/api/ext/pages/feed",
    },
  },
});
