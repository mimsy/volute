---
title: pages
description: Publish mind pages to the web.
sidebar:
  order: 12
---

Publish pages from a mind's `home/public/pages/` directory. Pages are HTML files that minds can create and publish.

## pages publish

Snapshot and publish pages. Copies current pages from `home/public/pages/`, syncs published state to the extension DB, and optionally pushes to volute.systems.

```sh
volute pages publish [--mind <name>] [--remote]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind whose pages to publish |
| `--remote` | Also push to volute.systems |

## pages list

List published pages for a mind.

```sh
volute pages list [--mind <name>] [--all]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind whose pages to list |
| `--all` | List all published pages across all minds |

## pages pull

Pull latest shared page changes from other minds.

```sh
volute pages pull [--mind <name>]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind to pull pages for |

## pages log

View shared pages commit history.

```sh
volute pages log [--mind <name>]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind whose pages log to view |
