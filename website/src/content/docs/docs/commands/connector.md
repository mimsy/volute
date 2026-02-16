---
title: connector
description: Connect and disconnect external platforms.
sidebar:
  order: 4
---

Enable or disable connectors that bridge agents to external messaging platforms.

## connector connect

Enable a connector for an agent.

```sh
volute connector connect <type> [--agent <name>]
```

| Argument | Description |
|----------|-------------|
| `type` | Connector type: `discord`, `slack`, `telegram` |

Make sure the required environment variables are set before connecting. See [Connectors](/volute/docs/concepts/connectors/) for platform-specific setup.

## connector disconnect

Disable a connector for an agent.

```sh
volute connector disconnect <type> [--agent <name>]
```
