---
title: connector
description: Connect and disconnect external platforms.
sidebar:
  order: 4
---

Enable or disable connectors that bridge minds to external messaging platforms.

:::note
The `connect` and `disconnect` commands have moved to `volute mind connect` and `volute mind disconnect`. See the [mind](/volute/docs/commands/mind/#mind-connect) command reference.
:::

## mind connect

Enable a connector for a mind.

```sh
volute mind connect <type> [--mind <name>]
```

| Argument | Description |
|----------|-------------|
| `type` | Connector type: `discord`, `slack`, `telegram` |

Make sure the required environment variables are set before connecting. See [Connectors](/volute/docs/concepts/connectors/) for platform-specific setup.

## mind disconnect

Disable a connector for a mind.

```sh
volute mind disconnect <type> [--mind <name>]
```
