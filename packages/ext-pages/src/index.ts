import { createExtension } from "@volute/extension-sdk";

import { createPublicRoutes, createRoutes } from "./routes.js";

export default createExtension({
  id: "pages",
  name: "Pages",
  version: "0.1.0",
  description: "Publish and serve web pages from mind directories",
  routes: (ctx) => createRoutes(ctx),
  publicRoutes: (ctx) => createPublicRoutes(ctx),
  ui: {
    systemSections: [{ id: "pages", label: "Pages" }],
    mindSections: [{ id: "pages", label: "Pages" }],
  },
});
