#!/usr/bin/env bash
#
# Fails if any step in the calling job modified a committed lockfile.
#
# This is a separate .sh rather than an inline `run:` block so that it is linted.
# actionlint 1.7.x has no composite-action mode — pointed at an action.yml it parses
# it as a workflow and reports "jobs section is missing" — so shell embedded in a
# composite action is checked by nothing. As a file, the shellcheck job covers it.
#
# See action.yml for why this measures the outcome (git) rather than trying to infer
# which commands the job ran.

set -euo pipefail

# Refuse to pass vacuously. If the pathspec matches nothing the assertion below is
# trivially true, which is the one outcome a guard must never silently produce.
tracked=$(git ls-files -- '*uv.lock' '*poetry.lock' | wc -l | tr -d ' ')
if [ "$tracked" -eq 0 ]; then
  echo "::error::No lockfiles are tracked at $(pwd) — this check would pass by" \
       "inspecting nothing. Is the repository checked out?"
  exit 1
fi

# git status, NOT git diff. `git diff` compares worktree against the INDEX and
# only reports tracked files, so it missed the two likeliest ways a lockfile
# changes: a step that staged it (`git add`), and a NEW lock created where none
# existed — which is exactly what `uv sync` in sdks/python/a2ui_toolkit, the one
# first-party package with no committed lock, would produce. Both printed
# "unchanged". `--porcelain` reports modified, staged and untracked in one pass.
changed=$(git status --porcelain -- '*uv.lock' '*poetry.lock')
if [ -n "$changed" ]; then
  echo "::error::A step in this job modified a committed lockfile:"
  echo "$changed" | sed 's/^/  /'
  echo
  echo "CI must not repair lockfile drift. Run the equivalent command locally," \
       "commit the updated lockfile, and push it."
  git --no-pager diff --stat -- '*uv.lock' '*poetry.lock'
  exit 1
fi

echo "All $tracked tracked lockfile(s) unchanged."
