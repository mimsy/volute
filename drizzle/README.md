# Database Migrations

## The Rule: No Hand-Written Migrations

**Never write SQL migration files by hand.** All migrations must be generated
from `schema.ts` using:

```sh
npm run db:generate
```

Drizzle tracks schema state via the `meta/` snapshots. Hand-written SQL breaks
this chain—the next `db:generate` won't know what exists, and you'll get
duplicate or conflicting migrations.

## Why This Matters

Volute uses **idempotent migrations** (`CREATE TABLE IF NOT EXISTS`, etc.) so
the same migration file can run safely on both fresh installs and existing
databases. This pattern only works when:

1. Every migration is generated from the source-of-truth schema
2. The `meta/` snapshots stay in sync with the SQL files
3. No one sneaks in manual DDL that the snapshots don't reflect

## Workflow

1. Edit `src/db/schema.ts`
2. Run `npm run db:generate` — it creates the migration and updates snapshots
3. Review the generated SQL (in `drizzle/NNNN_*.sql`)
4. Run `npm run db:migrate` to apply

If `db:generate` produces nothing, your schema change is already reflected.
If it produces something unexpected, your schema or the snapshots drifted—
investigate before committing.

## The Baseline

`0000_baseline.sql` is a squashed, idempotent snapshot of the entire schema
as of July 2024. It uses `IF NOT EXISTS` throughout so it runs as a no-op on
databases that already have these tables. All future migrations build on top
of this baseline.
