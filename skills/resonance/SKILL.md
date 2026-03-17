---
name: Resonance
description: Semantic memory engine — ingest text, search via full-text and/or vector similarity, find cross-memory connections, with strength/decay dynamics. Use for "resonance", "semantic search", "full-text search", "memory connections", "ingest memories", "decay", "resonance report".
metadata:
  npm-dependencies: libsql
  hooks:
    pre-prompt: scripts/resonance-hook.sh
---

# Resonance — Semantic Memory Engine

Not an archive — a memory. Stores text chunks with full-text indexing and optional vector embeddings. Finds what echoes across time, tracks which memories keep surfacing, lets unused ones drift deeper.

## When to use

- **During consolidation**: Run `resonance report` to find cross-day connections. Use these to inform what strengthens in MEMORY.md.
- **When writing**: After writing something significant, search for echoes: `resonance search "the theme you're exploring"`.
- **After writing journals/notes**: Run `resonance ingest <file>` to add new content.
- **Periodically**: Run `resonance ingest-all` to catch any new files.
- **Nightly**: Decay runs automatically if the nightly schedule was set up during install.

## Commands

```bash
npx tsx .claude/skills/resonance/scripts/resonance.ts <command>
```

| Command | Description |
|---------|-------------|
| `install` | First-time setup: copies config, creates schedule, runs initial ingestion. API key optional — works with FTS only. |
| `ingest <file>` | Ingest a single file (with embeddings if API key set, FTS-only otherwise) |
| `ingest-all` | Ingest all configured memory files |
| `search "query" [--limit N] [--fts] [--vector]` | Find memories. Default: hybrid (vector + FTS). `--fts`: keyword only. `--vector`: semantic only. Read-only — does not affect memory strength. |
| `recall <id> [id2 ...]` | Explicitly boost memories that were genuinely useful. Increases strength and recall count. |
| `random [--limit N] [--min-strength F] [--max-strength F]` | Pull random memories. Use for dreams, associative connections, or serendipitous rediscovery. |
| `report [--against <file>]` | Find cross-memory connections (defaults to today's journal) |
| `stats` | Database statistics |
| `decay` | Run decay pass (reduces strength of unrecalled memories) |

## Architecture

- **Storage**: libSQL database at `.mind/resonance.db` with native vector support (F32_BLOB) and FTS5 full-text index
- **Search modes**: Hybrid (default, combines both), `--fts` (keyword match, instant, no API key needed), `--vector` (semantic similarity via embeddings)
- **Embeddings**: Optional. Configurable provider (default: OpenRouter, `openai/text-embedding-3-small`, 1536 dimensions). Without an API key, everything works except vector search.
- **Similarity**: Cosine distance computed natively by libSQL (`vector_distance_cos`)
- **Chunking**: Markdown section-aware — splits on any heading level (`#` through `######`), with word-level sub-chunking for long sections. Skips trivially short chunks (< 15 words).
- **Strength**: Each memory has a strength value (0.1-1.0). Recalled memories get stronger (resonance boost). Unrecalled memories decay over time.
- **Resonance frequency**: Tracks how many times each memory has been surfaced by search.

## Design principles

- **Connections, not facts.** "What else felt like this?" not "what happened on March 6."
- **Good resonance, not total recall.** Funes memorized everything and couldn't generalize.
- **Forgetting is cognition.** Memories decay. The decay is a feature.
- **Strength as texture.** A memory recalled five times feels different from one never touched.

## Configuration

The default config is copied to `.config/resonance.json` during install. Edit it to customize. Fields are merged with built-in defaults.

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
| `ingestion` | `ignorePatterns` | `[]` | Regex patterns for lines to skip during ingestion |
| `dynamics` | `decayRate` | `0.02` | Strength lost per day without recall |
| `dynamics` | `minStrength` | `0.1` | Floor — memories never fully disappear |
| `dynamics` | `resonanceBoost` | `0.05` | Strength gained per recall |
