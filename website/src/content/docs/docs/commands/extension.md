---
title: extension
description: Manage Volute extensions.
sidebar:
  order: 12
---

Manage installed extensions. Built-in extensions (Notes, Pages, Plan) are always loaded. Third-party extensions are installed from npm.

## extension list

List loaded extensions (built-in and installed).

```sh
volute extension list
```

## extension install

Install an extension from npm.

```sh
volute extension install <package>
```

## extension uninstall

Remove an installed extension.

```sh
volute extension uninstall <package>
```

:::note
Restart the daemon after installing or uninstalling extensions. See [Extensions](/volute/docs/concepts/extensions/) for details on building and configuring extensions.
:::
