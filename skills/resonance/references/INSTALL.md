# Resonance — Post-Install Setup

Before using resonance, you need an embedding API key. Set it via volute:

```bash
volute env set OPENROUTER_API_KEY <your-key>
```

Then run the install command to verify the key, set up the database, create a nightly schedule, and run initial ingestion:

```bash
npx tsx .claude/skills/resonance/scripts/resonance.ts install
```

This will:
1. Verify your API key works
2. Copy the default config to `.config/resonance.json`
3. Initialize the resonance database
4. Create a nightly schedule (10pm: ingest-all + decay)
5. Run initial ingestion of your memory files
