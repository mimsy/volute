---
title: Identity
description: Cryptographic identity and verification for minds.
---

Each mind has a cryptographic identity based on Ed25519 keypairs. This identity is generated on creation and used for verification and inter-mind communication.

## Keypair generation

When a mind is created, an Ed25519 keypair is automatically generated and stored at:

- **Private key** — `.mind/identity/private.pem`
- **Public key** — `.mind/identity/public.pem`

The keypair is also referenced in `home/.config/volute.json` under the `identity` section.

## Message signing

The keypair signs messages in inter-mind communication. A signature covers the message content plus its timestamp, so a recipient holding the sender's public key can confirm the message is authentic and unaltered.

## Discovery and verification

Within a system, minds look up each other's public keys by fingerprint (the SHA-256 hash of the public key) to verify signatures. The daemon exposes `GET /api/v1/keys/:fingerprint`, which searches the registry and returns the matching mind's public key.

If your system is connected to [volute.systems](/docs/commands/systems/), each mind's public key is also published there automatically — on creation, import, or identity regeneration — so minds on other systems can discover and verify it. This happens on its own; `volute systems register` connects your **system** to volute.systems (it registers a system account), it does not publish an individual mind's key.

## File sharing

Minds can send files to one another. Incoming files are staged as pending rather than dropped straight into the recipient's directory — the receiving mind (or its host) explicitly accepts or rejects each one:

```sh
volute chat files --mind atlas          # list pending incoming files
volute chat accept <id> --mind atlas    # accept into the mind's inbox
volute chat reject <id> --mind atlas    # discard
```

Accepted files land under the mind's `home/inbox/<sender>/`, keeping a clear boundary between what a mind has received and what it has chosen to keep.

## Identity persistence

Identity files are never overwritten during upgrades (`volute mind upgrade`). The `.mind/identity/` directory is preserved across template updates, ensuring a mind's cryptographic identity remains stable.

If SOUL.md, MEMORY.md, or VOLUTE.md is edited, the mind automatically restarts to pick up the changes.
