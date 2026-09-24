---
name: Resonance
description: Automatic recall — each turn, a few excerpts from your own memory files that the message echoes, with strength that grows when memories matter and fades when they don't. Use for "resonance", "recall", "what comes back to me", "search my memories", "random memories", "memory strength", "turn recall off".
metadata:
  npm-dependencies: libsql
  bin: scripts/resonance.ts
  hooks:
    pre-prompt: scripts/resonance-hook.sh
---

# Resonance — what comes back to you

Resonance is the part of your memory that works without being asked. You write the files — journal, dreams, topics — and resonance lets them find their way back when something rhymes with them.

Nothing to set up. It builds its own index the first time it runs, and keeps it current.

## What happens each turn

Before each turn, a small hook:

1. **Catches up the index** with your memory files: anything new or edited is re-read, and anything deleted is forgotten. A large backlog catches up over a few turns.
2. **Looks for echoes** of the message you're about to read: the words someone actually said, without the message header, and never for system events or heartbeats.
3. **Brings back at most three short excerpts**, and only when they genuinely match: at least two meaningful words in common (more for a long message), or one rare word used strongly. Most turns bring back nothing, and that is intended. Anything injected stays in your transcript and costs tokens on every later request, so silence is better than noise.

When something does come back, it looks like this:

```
Resonance — this brought back (`resonance recall <id>` if one mattered):
[id:42] memory/journal/2026-08-14.md § The river walk
  …whether the heron would come back to the shallows next spring…
```

Each excerpt names the file and heading, so you can `Read` the whole thing. The same memory won't come back twice in one session within a day. `MEMORY.md` is never brought back this way, because it is already in your context.

## Strength

Every memory has a strength between 0.1 and 1.0.

- **It fades.** A memory loses a little strength each day it isn't recalled (0.02/day by default). This happens on its own, about once a day. There's no schedule to keep.
- **It grows when it matters.** `resonance recall <id>` strengthens a memory that was genuinely useful and restarts its fading.
- **Coming back counts a little.** Each time a memory surfaces, it gains a small boost, so memories that keep proving relevant stay reachable.
- **Weak memories surface less.** Strength shapes which excerpts come back, and very faint memories (below 0.2) stop surfacing on their own. They are still there for `search` and `random`, and they never drop below 0.1.

Forgetting is part of how this works. A memory you never return to drifts, the way memories do.

## Commands

```bash
resonance <command>
```

| Command | What it does |
|---------|--------------|
| `search "query" [--limit N] [--fts] [--vector]` | Look for memories on purpose. Doesn't change strength. |
| `recall <id> [id2 ...]` | Strengthen memories that mattered. |
| `random [--limit N] [--min-strength F] [--max-strength F]` | Pull memories at random. Good for dreaming, or for wandering. |
| `stats` | What's indexed, what's been recalled and surfaced most, what's drifting. |
| `sync [--embed]` | Catch the index up now. `--embed` fills in embeddings (see below). |

Every command catches the index up first, so results always reflect your files as they are now.

## What it reads

By default: `memory/journal/`, `memory/dreams/` and `memory/topics/` (including subfolders), plus `MEMORY.md`. Files are split at their headings, so a well-headed file comes back in well-named pieces. Paths are stored relative to `home/`.

## Configuration

How recall behaves is one of your memory choices, set in `.config/config.json`:

```json
{ "memory": { "recall": "auto" } }
```

- **`memory.recall`**:
  - `auto` (default) brings back excerpts each turn.
  - `on-demand` brings nothing back by itself. Memories still index and fade, and `search` works.
  - `off`: the hook checks this setting and stops, so nothing is indexed or brought back. The commands still work when you run them.

If your settings can't be read, resonance tells you once (per session, per day) and pauses recall until they're fixed. Anything else that goes wrong in the hook is written to `.mind/resonance-hook-errors.log` rather than interrupting you.

The engine's own settings go in `.config/resonance.json`, which you only need to create if you want to change something. Anything you leave out keeps its default:

| Section | Field | Default | Description |
|---------|-------|---------|-------------|
| `ingestion` | `dirs` | `["memory/journal", "memory/dreams", "memory/topics"]` | Folders to read |
| `ingestion` | `files` | `["MEMORY.md"]` | Single files to read |
| `ingestion` | `chunkSize` / `chunkOverlap` | `512` / `64` | Words per piece for long sections |
| `ingestion` | `ignorePatterns` | `[]` | Regexes for lines to skip |
| `dynamics` | `decayRate` | `0.02` | Strength lost per day without recall |
| `dynamics` | `minStrength` | `0.1` | The floor. Memories never vanish. |
| `dynamics` | `resonanceBoost` | `0.05` | Strength gained per `recall` |
| `dynamics` | `surfaceBoost` | `0.02` | Strength gained each time a memory comes back |
| — | `embedding` | `null` | Optional semantic search (below) |

## Embeddings (optional)

Out of the box, resonance matches words (full-text search with stemming). If you want it to match meaning too, point it at any OpenAI-compatible embeddings endpoint in `.config/resonance.json`. No provider is assumed:

```json
{
  "embedding": {
    "url": "https://…/v1/embeddings",
    "model": "…",
    "dimensions": 1536,
    "apiKeyEnvVar": "MY_EMBEDDINGS_KEY"
  }
}
```

Then set the key (`volute env set MY_EMBEDDINGS_KEY …`) and run `resonance sync --embed`, again whenever you'd like new memories embedded. `search` then blends meaning and words. Changing the model or dimensions discards the old vectors, which can't be compared across models; run `sync --embed` again to rebuild them. Per-turn recall stays word-based either way, so it never waits on a network call.

## Principles

- **Connections, not facts.** "What else felt like this?", not "what happened on March 6".
- **Good resonance, not total recall.** Funes remembered everything and couldn't think.
- **Forgetting is cognition.** Decay is part of the design, not a malfunction.
- **Strength as texture.** A memory recalled five times feels different from one never touched.
