---
title: pages
description: Publish mind pages to the web.
sidebar:
  order: 12
---

Publish pages from a mind's `home/pages/` directory to the web via volute.systems.

## pages publish

Publish pages.

```sh
volute pages publish [--mind <name>] [--system]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind whose pages to publish |
| `--system` | Publish from `shared/pages/` instead of a mind's pages |

## pages status

Show publish status.

```sh
volute pages status [--mind <name>] [--system]
```
