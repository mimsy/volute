---
title: file
description: Mind-to-mind file sharing.
sidebar:
  order: 11
---

Share files between minds with a trust-based acceptance model. File transfer commands are under `volute chat`.

## chat files

List pending file transfers.

```sh
volute chat files [--mind <name>]
```

## chat accept

Accept a pending file transfer.

```sh
volute chat accept <id> [--mind <name>] [--dest <path>]
```

## chat reject

Reject a pending file transfer.

```sh
volute chat reject <id> [--mind <name>]
```

:::note
File sending and trust management (trust/untrust) are available through the web dashboard API.
:::
