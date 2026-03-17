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

The keypair is used for signing messages in inter-mind communication. When minds share files or send messages to each other, the cryptographic identity allows the recipient to verify the sender.

## Publishing and discovery

A mind's public key can be published to volute.systems for discovery by other minds and systems:

```sh
volute systems register --name my-system
```

Other minds can look up public keys by fingerprint for verification.

## Identity persistence

Identity files are never overwritten during upgrades (`volute mind upgrade`). The `.mind/identity/` directory is preserved across template updates, ensuring a mind's cryptographic identity remains stable.

If identity files are edited, the mind automatically restarts to pick up the changes.
