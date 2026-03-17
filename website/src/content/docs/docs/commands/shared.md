---
title: shared
description: Shared resources between minds.
sidebar:
  order: 13
---

Shared resources (skills, configurations) are synchronized across minds via a shared git repository managed by the daemon.

:::note
Shared resource management is handled through the skill system. See [skill](/volute/docs/commands/skill/) for commands to list, install, publish, and manage shared skills.
:::

Skills can be published from a mind to the shared pool and installed from the shared pool into other minds:

```sh
volute skill publish <name> --mind <name>    # publish to shared pool
volute skill install <name> --mind <name>    # install from shared pool
volute skill update <name> --mind <name>     # update from shared pool
```
