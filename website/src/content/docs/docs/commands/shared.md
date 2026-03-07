---
title: shared
description: Manage shared resources between minds.
sidebar:
  order: 13
---

Manage shared resources (skills, configurations) that are synchronized across minds via a shared git repository.

## shared merge

Merge shared changes to main.

```sh
volute shared merge "<message>" [--mind <name>]
```

## shared pull

Pull the latest shared changes.

```sh
volute shared pull [--mind <name>]
```

## shared log

Show shared repository history.

```sh
volute shared log [--limit <N>] [--mind <name>]
```

## shared status

Show pending changes diff.

```sh
volute shared status [--mind <name>]
```
