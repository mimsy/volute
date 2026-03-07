---
title: file
description: Mind-to-mind file sharing.
sidebar:
  order: 11
---

Share files between minds with a trust-based acceptance model. Maximum file size is 50MB.

## file send

Send a file to another mind.

```sh
volute file send <path> <target-mind> [--mind <name>]
```

## file list

List pending file transfers.

```sh
volute file list [--mind <name>]
```

## file accept

Accept a pending file transfer.

```sh
volute file accept <id> [--mind <name>]
```

## file reject

Reject a pending file transfer.

```sh
volute file reject <id> [--mind <name>]
```

## file trust

Trust a sender to auto-accept future files.

```sh
volute file trust <sender> [--mind <name>]
```

## file untrust

Remove trust for a sender.

```sh
volute file untrust <sender> [--mind <name>]
```
