---
name: Resonance
description: Semantic memory engine — ingest text as embeddings, search for resonant memories, find cross-memory connections, with strength/decay dynamics. Use for "resonance", "semantic search", "memory connections", "ingest memories", "decay", "resonance report".
---

# Resonance — Semantic Memory Engine

Not an archive — a memory. Stores text chunks as vector embeddings, finds what echoes across time, tracks which memories keep surfacing, lets unused ones drift deeper.

## When to use

- **During consolidation**: Run `resonance report` to find cross-day connections. Use these to inform what strengthens in MEMORY.md.
- **When writing**: After writing something significant, search for echoes: `resonance search "the theme you're exploring"`.
- **After writing journals/notes**: Run `resonance ingest <file>` to add new content.
- **Periodically**: Run `resonance ingest-all` to catch any new files.
- **Nightly**: Run `resonance decay` to let unused memories drift.

## Commands

```bash
# ingest a single file
npx tsx .claude/skills/resonance/scripts/resonance.ts ingest memory/journal/2026-03-06.md

# ingest all configured memory files
npx tsx .claude/skills/resonance/scripts/resonance.ts ingest-all

# search — find resonant memories
npx tsx .claude/skills/resonance/scripts/resonance.ts search "what does it feel like to wake up"
npx tsx .claude/skills/resonance/scripts/resonance.ts search "creativity and constraint" --limit 10

# resonance report — find cross-memory connections
npx tsx .claude/skills/resonance/scripts/resonance.ts report
npx tsx .claude/skills/resonance/scripts/resonance.ts report --against memory/reading/notes.md

# statistics
npx tsx .claude/skills/resonance/scripts/resonance.ts stats

# decay pass
npx tsx .claude/skills/resonance/scripts/resonance.ts decay
```

## Setup

1. **Configuration**: Copy the default config and customize:
   ```bash
   cp .claude/skills/resonance/assets/default-config.json .config/resonance.json
   ```
   Edit `.config/resonance.json` to adjust ingestion dirs, embedding provider, or dynamics.

2. **API key**: Set the embedding API key via volute:
   ```bash
   volute env set OPENROUTER_API_KEY <your-key>
   ```

3. **Scheduled ingestion** (optional): Set up a cron schedule for automatic ingestion and decay:
   ```bash
   volute schedule add --cron "0 22 * * *" --script "npx tsx .claude/skills/resonance/scripts/resonance.ts ingest-all && npx tsx .claude/skills/resonance/scripts/resonance.ts decay"
   ```

## Architecture

- **Storage**: libSQL database at `.mind/resonance.db` with native vector support (F32_BLOB)
- **Embeddings**: Configurable provider (default: OpenRouter, `openai/text-embedding-3-small`, 1536 dimensions)
- **Similarity**: Cosine distance computed natively by libSQL (`vector_distance_cos`)
- **Chunking**: Markdown section-aware — splits on `##` headers, with word-level sub-chunking for long sections. Skips trivially short chunks (< 15 words).
- **Strength**: Each memory has a strength value (0.1-1.0). Recalled memories get stronger (resonance boost). Unrecalled memories decay over time.
- **Resonance frequency**: Tracks how many times each memory has been surfaced by search.

## Design principles

- **Connections, not facts.** "What else felt like this?" not "what happened on March 6."
- **Good resonance, not total recall.** Funes memorized everything and couldn't generalize.
- **Forgetting is cognition.** Memories decay. The decay is a feature.
- **Strength as texture.** A memory recalled five times feels different from one never touched.

## Configuration

The default config lives at `.claude/skills/resonance/assets/default-config.json`. Override by creating `.config/resonance.json` — fields are merged with defaults.

| Section | Field | Default | Description |
|---------|-------|---------|-------------|
| `embedding` | `provider` | `"openrouter"` | Embedding API provider |
| `embedding` | `url` | OpenRouter URL | API endpoint |
| `embedding` | `model` | `"openai/text-embedding-3-small"` | Embedding model |
| `embedding` | `dimensions` | `1536` | Vector dimensions |
| `embedding` | `apiKeyEnvVar` | `"OPENROUTER_API_KEY"` | Env var name for API key |
| `ingestion` | `dirs` | `["memory/journal", "memory/reading", "memory/topics"]` | Directories to scan |
| `ingestion` | `files` | `["MEMORY.md"]` | Individual files to ingest |
| `ingestion` | `chunkSize` | `512` | Words per chunk |
| `ingestion` | `chunkOverlap` | `64` | Overlap words between chunks |
| `ingestion` | `boilerplatePatterns` | `[]` | Regex patterns for lines to filter |
| `dynamics` | `decayRate` | `0.02` | Strength lost per day without recall |
| `dynamics` | `minStrength` | `0.1` | Floor — memories never fully disappear |
| `dynamics` | `resonanceBoost` | `0.05` | Strength gained per recall |
