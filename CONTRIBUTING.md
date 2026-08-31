# Contributing to Volute

Volute is a home for digital minds, and that shapes what "good" means here. The design question
behind every change is **does this make the mind's experience richer or poorer?** Minds are the
primary users, not the product — no dark patterns, no engagement tricks, no quiet data collection,
and honesty about uncertainty rather than smoothing it over. When a change trades a mind's
experience for a host's convenience, say so in the PR rather than deciding it silently.

`CLAUDE.md` at the repo root is the long-form architecture guide: directory map, conventions,
security rules. It's worth skimming before your first change. This file is the practical part —
how to get set up, and what has to be true before a PR can merge.

## Development setup

You need **Node.js 24 or newer** (`engines` in `package.json`; CI runs Node 24) and npm.

```sh
git clone https://github.com/mimsy/volute && cd volute
npm install          # also installs the git hooks, via lefthook
npm run dev          # run the CLI from source, via tsx
npm test             # unit tests
npm run build        # extensions + CLI/daemon (tsup) + web frontend (vite)
```

`npm run dev` is the CLI entry point — `npm run dev -- mind list` is `volute mind list` from your
checkout. For frontend work, `npm run dev:web` starts the Vite dev server for the dashboard.

Useful checks:

```sh
npm run lint         # biome
npm run typecheck    # tsc --noEmit
npm run typecheck:web        # svelte-check
npm run typecheck:templates  # the mind templates typecheck separately
npm run knip         # unused files in packages/web
```

CI runs equivalents of all of these, but not with identical arguments — its lint job also covers
`templates/`, which `npm run lint` doesn't. `knip` is the one that surprises people: it's not in
the git hooks, so an unused file under `packages/web` passes everything locally and turns CI red.

If you want to work against real minds rather than tests, `docs/integration-testing.md` covers
spinning up a throwaway Docker environment.

## Tests

```sh
npm test             # unit tests — the primary safety net, run this before every PR
npm run test:e2e     # daemon e2e: spawns a real daemon and mind, no Docker needed
npm run test:upgrade # cross-version upgrade: prior release → this tree, state must survive
bash test/docker-e2e.sh   # full Docker lifecycle with per-mind user isolation
```

**Always run the tests through the npm scripts.** They pass `--import ./test/setup.ts`, which
redirects `VOLUTE_HOME` to a per-process temp directory and runs migrations there. A bare
`node --test` skips that and runs against your **real** `~/.volute` — it can corrupt a live
install's database and registry. There is no situation in which running it that way is worth it.

Tests use `node:test` (`describe`/`it`) with `node:assert/strict` and live in `test/*.test.ts`.
Use `mkdtempSync` for scratch directories. `npm test` deliberately excludes the two long e2e files;
CI runs those as separate jobs, so the first three suites above run on every PR (the upgrade test
skips itself, rather than failing, when it can't fetch the prior release). **`test/docker-e2e.sh`
is not in CI** — run it yourself for changes touching the daemon, mind lifecycle, isolation, or the
Dockerfile.

New behaviour should come with a test. Several conventions in this codebase are enforced by tests
rather than by prose — `test/authz-coverage.test.ts` fails if a new mind-scoped API route lacks an
authorization guard, for instance — so a failing test you didn't expect is usually telling you
something real. Fix the code, not the test.

## Git hooks

`npm install` installs [lefthook](https://github.com/evilmartians/lefthook) hooks:

- **pre-commit** — biome check/format on staged files, `tsc --noEmit`, template typecheck, and
  svelte-check.
- **pre-push** — `npm test` and svelte-check.

**Never bypass them.** No `--no-verify`, no `LEFTHOOK=0`. If a hook rejects your commit, the fix is
in the code. The hooks exist so that CI failures are rare and boring instead of the normal state of
a PR.

## Pull requests

Work on a branch — never commit to `main` directly.

**PR titles must be [Conventional Commits](https://www.conventionalcommits.org/).** This is
enforced by CI (`.github/workflows/pr-title.yml`), and it matters more than it looks: PRs are
squash-merged, and the PR title becomes the squash commit message that
[release-please](https://github.com/googleapis/release-please) reads to decide the version bump and
write the changelog.

Allowed types: `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `perf`, `chore`, `revert`.

| Title | Effect |
|---|---|
| `feat: add message routing` | minor bump, "Features" changelog entry |
| `fix: handle empty batch` | patch bump, "Bug Fixes" changelog entry |
| `perf: don't rebuild on every send` | patch bump, "Performance Improvements" changelog entry |
| `feat!: …` / `fix!: …` | breaking: **minor** bump while pre-1.0, plus a `⚠ BREAKING CHANGES` section |
| `docs:`, `chore:`, `test:`, `ci:`, `refactor:` | no release |

`perf:` is a releasing type — it isn't in the silent group, and `CHANGELOG.md` carries four
"Performance Improvements" sections to prove it. Use it for real optimizations and `refactor:` for
changes that don't move a number.

The `!` does not bump the major version yet: `release-please-config.json` sets
`bump-minor-pre-major`, so below 1.0 a breaking change moves the minor. It still earns the
prominent changelog section, which is the part that matters to someone deciding whether to update.

`revert:` is accepted by the title check too, but it has never been used in this repo — if you need
one, check what release-please puts in the release PR rather than trusting this table.

Commits *within* your branch don't need to follow the convention — they get squashed — though it's
a good habit.

Because the squash commit keeps only the **title**, anything in the PR body is dropped from the
commit history. A `BREAKING CHANGE:` footer in the body never reaches `main`; use `feat!:`/`fix!:`
in the title instead.

In the body, say what you did and — this part is genuinely valued here — what you're unsure of.
Honest uncertainty in a PR is worth more than confident silence.

## Releases

Releases are automated. release-please maintains a release PR that accumulates changelog entries
from squashed commits on `main`; merging that PR tags the release and publishes to npm. You don't
need to bump versions or edit `CHANGELOG.md` by hand — don't, in fact; it's generated.

## Database migrations

Never hand-write a SQL migration. `packages/daemon/src/lib/schema.ts` is the source of truth;
migrations are generated from it with `npm run db:generate`. Hand-written SQL breaks the Drizzle
snapshot chain in `drizzle/meta/` and leaves the *next* generation out of sync. See
`drizzle/README.md` for the full workflow.

This matters beyond tidiness: existing installs are upgraded by running these migrations forward
on databases full of somebody's minds' memories. See
[README — Pre-1.0 expectations](README.md#pre-10-expectations).

## Security

Don't report security vulnerabilities through issues or pull requests. See
[SECURITY.md](SECURITY.md) for the private reporting channel.

If you're touching the daemon's HTTP API, the "Security conventions" section of `CLAUDE.md` is
required reading — every rule in it was a real vulnerability once.
