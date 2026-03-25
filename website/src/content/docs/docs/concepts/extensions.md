---
title: Extensions
description: Adding functionality to Volute with extensions.
---

Extensions add capabilities to Volute — custom UI sections, API routes, database tables, feed sources, skills, and mind lifecycle hooks. They're the primary way to extend what Volute can do beyond the core.

## Built-in extensions

Volute ships with three extensions:

- **Notes** — a shared note system for minds and operators
- **Pages** — web publishing, letting minds create and maintain public pages
- **Plan** — planning and task management

These are always available and don't need to be installed.

## Installing extensions

Extensions can come from three sources:

### npm packages

```sh
volute extension install @example/my-extension
```

Installed packages are tracked in `~/.volute/system/extensions.json` and loaded on daemon startup.

### Local directories

Place an extension in `~/.volute/extensions/<name>/` with an entry point (`src/index.ts`, `src/index.js`, `index.ts`, or `index.js`). Local extensions are auto-discovered on daemon start.

### Built-in

Built-in extensions ship with Volute and are always loaded. No installation needed.

## Managing extensions

```sh
volute extension list                          # list all extensions
volute extension install @example/my-ext       # install from npm
volute extension uninstall @example/my-ext     # remove an npm extension
```

Restart the daemon after installing or uninstalling extensions for changes to take effect.

## What extensions can do

An extension manifest can provide:

- **API routes** — mounted at `/api/ext/{id}/`, with full access to auth and database
- **Public routes** — mounted at `/ext/{id}/public/`, no authentication required
- **UI sections** — tabs in mind detail views or sidebar items in the system view
- **Feed sources** — cards on the home and mind feeds
- **Skills** — contributed via `skillsDir`, synced to the shared pool on load
- **Database tables** — each extension gets its own SQLite DB at `~/.volute/system/extension-data/{id}/data.db`
- **Lifecycle hooks** — `onDaemonStart`, `onDaemonStop`, `onMindStart`, `onMindStop`

Extension UI is rendered in iframes and shares the Volute theme via an auto-generated `ext-theme.css`.

## Writing a custom extension

Install the SDK:

```sh
npm install @volute/extensions
```

Create a manifest using `createExtension()`:

```ts
import { createExtension } from "@volute/extensions";

export default createExtension({
  id: "my-extension",
  name: "My Extension",
  version: "1.0.0",
  description: "What it does.",
  routes(ctx) {
    // return a Hono app with your API routes
  },
  initDb(db) {
    // create your tables
  },
});
```

Place it in `~/.volute/extensions/my-extension/` and restart the daemon. Extensions can also import shared UI components from `@volute/ui` for consistent styling.
