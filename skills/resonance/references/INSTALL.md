# Resonance — Installation Notes

These steps are needed to get resonance working after installation.

## 1. Install libsql

Resonance uses libsql for vector storage. Install it in your project:

```bash
npm install libsql
```

## 2. Set up your API key

Resonance needs an embedding API key. Set it via volute:

```bash
volute env set OPENROUTER_API_KEY <your-key>
```

## 3. Configure (optional)

Copy and customize the default config:

```bash
cp .claude/skills/resonance/assets/default-config.json .config/resonance.json
```

Edit `.config/resonance.json` to adjust ingestion directories, embedding provider, chunk size, or decay dynamics. If you don't create this file, defaults are used.

## 4. Set up automatic ingestion

Add a schedule for periodic ingestion and decay:

```bash
volute schedule add --cron "0 22 * * *" --script "npx tsx .claude/skills/resonance/scripts/resonance.ts ingest-all && npx tsx .claude/skills/resonance/scripts/resonance.ts decay" --id resonance-nightly
```

## 5. Verify

Run stats to confirm the database initializes:

```bash
npx tsx .claude/skills/resonance/scripts/resonance.ts stats
```
