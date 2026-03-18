---
title: connector
description: Connect external platforms to minds.
sidebar:
  order: 4
---

Connectors bridge minds to external messaging platforms (Discord, Slack, Telegram).

:::note
Connector management is done through the web dashboard or `volute chat bridge` commands. Set the required environment variables first (see [Connectors](/volute/docs/concepts/connectors/) for platform-specific setup), then use:

```sh
volute chat bridge add <type> [--mind <name>]
volute chat bridge remove <type> [--mind <name>]
volute chat bridge list [--mind <name>]
```
:::
