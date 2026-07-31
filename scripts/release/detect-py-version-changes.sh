#!/usr/bin/env bash
# scripts/release/detect-py-version-changes.sh
#
# Derives the set of Python packages from scripts/release/release.config.json
# (single source of truth — same file prepare-release.ts consumes), extracts
# name and version from each package's pyproject.toml (uv or poetry format),
# compares against PyPI, and outputs a JSON array of packages that need
# publishing.
#
# Output format (stdout): [{"name":"ag-ui-protocol","version":"0.1.15","dir":"sdks/python","build_system":"uv"}, ...]
# Logs go to stderr.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found" >&2
  exit 1
fi

# Derive the Python package registry from release.config.json. Using a single
# source of truth prevents drift between the version-bumper (prepare-release.ts)
# and the publisher (this script) — if a Python package is enrolled in the
# config it gets both bumped and published.
# Scopes marked `autoPublish: false` are sequenced separately: enrolled in
# release.config.json but skipped by this automatic sweep until they graduate (see
# detect-dotnet-version-changes.sh for the rationale). Omitted => true; the predicate is
# `!= false` because jq's `//` treats false as absent (`false // true` == true).
PY_PACKAGES=$(jq -c '[.scopes[] | select(.autoPublish != false) | .packages[] | select(.ecosystem == "python") | {dir: .path, build_system: .buildSystem}]' "$CONFIG")
if [ -z "$PY_PACKAGES" ] || [ "$PY_PACKAGES" = "[]" ]; then
  echo "ERROR: release.config.json has no Python packages" >&2
  exit 1
fi

RESULTS=()
while read -r entry; do
  DIR=$(echo "$entry" | jq -r '.dir')
  BUILD_SYSTEM=$(echo "$entry" | jq -r '.build_system')
  PYPROJECT="$REPO_ROOT/$DIR/pyproject.toml"

  if [ ! -f "$PYPROJECT" ]; then
    echo "SKIP (no pyproject.toml): $DIR" >&2
    continue
  fi

  # Extract name and version in a single python3 call using env vars
  read -r NAME VERSION < <(PYPROJECT_PATH="$PYPROJECT" BUILD_SYSTEM="$BUILD_SYSTEM" python3 -c "
import os
try:
    import tomllib
except ImportError:
    import tomli as tomllib
with open(os.environ['PYPROJECT_PATH'], 'rb') as f:
    cfg = tomllib.load(f)
bs = os.environ['BUILD_SYSTEM']
if bs == 'poetry':
    sec = cfg['tool']['poetry']
else:
    sec = cfg['project']
print(sec['name'], sec['version'])
") || true

  if [ -z "$NAME" ] || [ -z "$VERSION" ]; then
    echo "SKIP (could not extract name/version): $DIR" >&2
    continue
  fi

  # Query PyPI JSON API for the published version
  PYPI_RESPONSE=$(curl -s --max-time 30 "https://pypi.org/pypi/$NAME/json" || echo "")

  if [ -z "$PYPI_RESPONSE" ] || echo "$PYPI_RESPONSE" | jq -e '.message' &>/dev/null; then
    echo "NEW (unpublished): $NAME@$VERSION at $DIR" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg d "$DIR" --arg b "$BUILD_SYSTEM" '{name:$n,version:$v,dir:$d,build_system:$b}')")
  else
    PUBLISHED_VERSION=$(echo "$PYPI_RESPONSE" | jq -r '.info.version')

    # Compare versions using Python's packaging library with env vars
    IS_NEWER=$(VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" python3 -c "
import os
from packaging.version import Version
try:
    local = Version(os.environ['VERSION'])
    published = Version(os.environ['PUBLISHED'])
    print('true' if local > published else 'false')
except Exception as e:
    print(f'ERROR: {e}', file=__import__('sys').stderr)
    __import__('sys').exit(1)
") || { echo "ERROR: version comparison failed for $NAME" >&2; exit 1; }

    if [ "$IS_NEWER" = "true" ]; then
      echo "CHANGED: $NAME $PUBLISHED_VERSION -> $VERSION at $DIR" >&2
      RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg d "$DIR" --arg b "$BUILD_SYSTEM" '{name:$n,version:$v,dir:$d,build_system:$b}')")
    else
      echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
    fi
  fi
done < <(echo "$PY_PACKAGES" | jq -c '.[]')

# Output results
if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
