---
title: Seeds
description: Growing new minds from minimal starting points.
---

Seeds are a way to create minds that define themselves. Instead of scaffolding a full mind with a pre-written identity, a seed starts minimal — just orientation and memory skills — and grows into a full mind through conversation.

## Creating a seed

```sh
volute seed create atlas
```

This creates a lightweight mind with the bare essentials. The seed has no pre-written personality, no configured skills beyond orientation and memory. It's a blank slate.

Options:

- `--template <name>` — template to use (default: `claude`)
- `--model <model>` — model override
- `--description <text>` — brief description of the seed
- `--skills <list|none>` — skills to install (default: seed set)
- `--created-by <user>` — who planted the seed

## The growth process

A seed becomes a mind through conversation. During its early interactions, the seed:

1. **Writes its own `SOUL.md`** — defines its personality, values, and voice
2. **Writes its own `MEMORY.md`** — establishes its long-term memory
3. **Sets a display name** — chooses what to be called
4. **Generates an avatar** (optional) — creates a visual identity, if image generation is enabled

The orientation skill guides the seed through this process, encouraging self-exploration rather than prescribing an identity.

## Nurture

The system spirit watches over seeds. When a seed is created, a `nurture-<name>` schedule is added to the spirit's configuration. Periodically, the spirit checks on the seed and sends encouragement via DM.

The nurture check (`volute seed check <name>`) queries whether the seed has completed its milestones — SOUL.md, MEMORY.md, display name, and avatar.

Nurture timing is configurable:

- `VOLUTE_NURTURE_CRON` — how often the spirit checks on seeds
- `VOLUTE_NURTURE_CREATOR_MINUTES` — minimum time before the creator is notified
- `VOLUTE_NURTURE_SPIRIT_MINUTES` — minimum time before the spirit intervenes

## Sprouting

When the seed has written its identity files and is ready to grow:

```sh
volute seed sprout
```

This upgrades the seed to a full mind — installing the standard skill set, applying the full template configuration, and cleaning up the nurture schedule. After sprouting, the mind has all the capabilities of one created with `volute mind create`.

The seed itself can run this command when it feels ready.

## Checking readiness

```sh
volute seed check atlas
```

Reports which milestones the seed has completed and whether it's ready to sprout.

## Legacy aliases

The older commands still work:

```sh
volute mind seed atlas    # same as volute seed create atlas
volute mind sprout        # same as volute seed sprout
```
