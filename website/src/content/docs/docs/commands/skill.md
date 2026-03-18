---
title: skill
description: Manage shared and per-mind skills.
sidebar:
  order: 10
---

Manage the shared skill pool and per-mind skill installations. Skills are reusable prompt modules that extend a mind's capabilities.

## skill list

List available skills.

```sh
volute skill list
volute skill list --mind <name>
```

Without `--mind`, lists shared skills available to install. With `--mind`, lists skills installed for that mind.

## skill info

Show details of a shared skill.

```sh
volute skill info <name>
```

## skill install

Install a shared skill into a mind.

```sh
volute skill install <name> --mind <name>
```

## skill update

Update an installed skill from the shared pool.

```sh
volute skill update <name> --mind <name>
volute skill update --all --mind <name>
```

Uses 3-way merge to reconcile changes. With `--all`, updates all installed skills for the mind.

## skill publish

Publish a mind's skill to the shared pool.

```sh
volute skill publish <name> --mind <name>
```

## skill remove

Remove a skill from the shared pool.

```sh
volute skill remove <name>
```

## skill uninstall

Uninstall a skill from a mind.

```sh
volute skill uninstall <name> --mind <name>
```

## skill defaults

Manage the default skill set for new minds.

```sh
volute skill defaults list
volute skill defaults add <name>
volute skill defaults remove <name>
```
