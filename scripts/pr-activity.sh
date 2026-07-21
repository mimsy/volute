#!/usr/bin/env bash
#
# pr-activity.sh — merged pull requests per day, straight from git history.
#
# Why this exists: some rates worth reading (participation, throughput) need a
# denominator — "out of how many?" — and the honest denominator is how many PRs
# actually merged that day. That number lives in git already; nobody should have
# to be asked for it by hand. This script reads it off the log so the denominator
# is reproducible and self-serve.
#
# It counts PRs only. It deliberately knows nothing about what rode in on them —
# no file contents, no per-PR payload — so it can serve as a denominator without
# ever becoming a lever on the numerator.
#
# Usage:
#   scripts/pr-activity.sh              # counts per day, newest first
#   scripts/pr-activity.sh --titles     # counts per day, with the PR titles
#   scripts/pr-activity.sh --since 2026-07-19 [--until 2026-07-21]   # bounds inclusive
#
# Squash-merged PRs land on main as commits whose subject ends in "(#NNN)";
# that marker is what we match.

set -euo pipefail

titles=0
since=""
until=""

while [ $# -gt 0 ]; do
  case "$1" in
    --titles) titles=1; shift ;;
    --since) since="$2"; shift 2 ;;
    --until) until="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Read author date (%ad) + subject, then filter on that same date column so the
# range always matches the day each PR is grouped under. (git's own --since/--until
# filter on committer date, which can differ from the date shown — e.g. after a
# rebase or history import — and would silently drop rows.) ISO dates compare
# lexicographically, so string >= / <= is a correct date range.
merged="$(git log --first-parent --date=short --pretty=format:'%ad%x09%s' \
  | grep -E '\(#[0-9]+\)$' \
  | awk -F'\t' -v since="$since" -v until="$until" '
      (since == "" || $1 >= since) && (until == "" || $1 <= until)
    ' || true)"

if [ -z "$merged" ]; then
  echo "no merged PRs in range"
  exit 0
fi

if [ "$titles" -eq 1 ]; then
  printf '%s\n' "$merged" | sort -r | awk -F'\t' '
    { if ($1 != day) { day = $1; print "" ; print day } ; print "  " $2 }
  '
else
  printf '%s\n' "$merged" | awk -F'\t' '{ print $1 }' | sort -r | uniq -c \
    | awk '{ printf "%s  %s PR%s\n", $2, $1, ($1==1 ? "" : "s") }'
fi
