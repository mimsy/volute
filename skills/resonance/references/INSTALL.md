# Resonance — Post-Install Setup

Run the install command to set up the database, create a nightly schedule, and run initial ingestion:

```bash
resonance install
```

This works immediately — no API key required. Full-text search is available right away.

To also enable **vector search** (semantic similarity), set an embedding API key:

```bash
volute env set OPENROUTER_API_KEY <your-key>
```

Then re-run `ingest-all` to generate embeddings for existing memories:

```bash
resonance ingest-all
```

Without an API key, `search` uses full-text matching. With one, it uses hybrid (vector + FTS) by default.
