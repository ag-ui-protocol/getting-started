#!/usr/bin/env bash
# scripts/release/detect-ts-version-changes.sh
#
# Discovers publishable TypeScript packages from the pnpm workspace,
# filters to packages explicitly enrolled in scripts/release/release.config.json,
# compares each version against npm, and outputs a JSON array of packages
# that need publishing.
#
# The allowlist filter is a hard requirement: without it, any workspace
# package whose local version > npm version would be swept into the next
# publish on any merged PR to main. That includes packages the team
# intentionally hasn't wired up for release yet.
#
# Output format (stdout): [{"name":"@ag-ui/core","version":"0.0.49","path":"sdks/typescript/packages/core"}, ...]
# Logs go to stderr so they don't corrupt the JSON output.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found" >&2
  exit 1
fi

# Preflight: semver precedence (especially prerelease ordering) needs the
# 'semver' npm package, which we invoke via `node -e` below. That require()
# only resolves once node_modules is populated. Fail early with a clear
# message if dependencies aren't installed — otherwise the caller's
# `|| echo "[]"` fallback silently swallows the failure and the publish
# workflow no-ops instead of publishing what it should.
if ! (cd "$REPO_ROOT" && node -e "require('semver')") 2>/dev/null; then
  echo "ERROR: 'semver' module not resolvable from $REPO_ROOT." >&2
  echo "       Run 'pnpm install --frozen-lockfile' before this script." >&2
  exit 1
fi

# Build allowlist: every TypeScript package name listed under any scope.
# Scopes marked `autoPublish: false` are sequenced separately: enrolled in
# release.config.json but skipped by this automatic sweep until they graduate (see
# detect-dotnet-version-changes.sh for the rationale). Omitted => true; the predicate is
# `!= false` because jq's `//` treats false as absent (`false // true` == true).
ALLOWLIST=$(jq -r '[.scopes[] | select(.autoPublish != false) | .packages[] | select(.ecosystem == "typescript") | .name] | sort | unique | join("\n")' "$CONFIG")
if [ -z "$ALLOWLIST" ]; then
  echo "ERROR: release.config.json has no TypeScript packages" >&2
  exit 1
fi

# Get all workspace packages as JSON
PACKAGES=$(cd "$REPO_ROOT" && pnpm list -r --json) || { echo "ERROR: pnpm list failed" >&2; exit 1; }
if [ -z "$PACKAGES" ] || [ "$PACKAGES" = "[]" ]; then
  echo "ERROR: pnpm list returned no packages" >&2; exit 1
fi

# Iterate over each package using process substitution to avoid subshell
RESULTS=()
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  PKG_PATH=$(echo "$pkg" | jq -r '.path')
  RELATIVE_PATH="${PKG_PATH#"$REPO_ROOT"/}"
  PRIVATE=$(echo "$pkg" | jq -r '.private // false')

  # Skip private packages
  if [ "$PRIVATE" = "true" ]; then
    echo "SKIP (private): $NAME" >&2
    continue
  fi

  # Skip apps/* packages (examples/demos, not publishable libraries)
  if [[ "$RELATIVE_PATH" == apps/* ]]; then
    echo "SKIP (app): $NAME" >&2
    continue
  fi

  # Skip mastra examples
  if [[ "$RELATIVE_PATH" == *examples* ]]; then
    echo "SKIP (example): $NAME" >&2
    continue
  fi

  # Enforce the release-config allowlist: skip anything not explicitly
  # enrolled. This is what prevents unrelated workspace packages (e.g.
  # server-starter, vercel-ai-sdk) from being swept into a publish on
  # any unrelated PR merge.
  if ! grep -Fxq -- "$NAME" <<<"$ALLOWLIST"; then
    echo "SKIP (not in release.config.json): $NAME" >&2
    continue
  fi

  # Query npm for the published version
  if PUBLISHED_VERSION=$(npm view "$NAME" version 2>/dev/null); then
    # Package exists on npm. Use the semver package (available via nx's
    # transitive deps) for correct prerelease-aware comparison.
    IS_NEWER=$(VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" node -e "
      const semver = require('semver');
      const local = process.env.VERSION;
      const pub = process.env.PUBLISHED;
      if (!semver.valid(local) || !semver.valid(pub)) {
        console.error('ERROR: invalid semver: local=' + local + ' published=' + pub);
        process.exit(1);
      }
      // semver.gt correctly handles prerelease ordering per semver.org:
      //   1.2.3 > 1.2.3-alpha.1 > 1.2.3-alpha.0 > 1.2.3-alpha
      console.log(semver.gt(local, pub) ? 'true' : 'false');
    ") || { echo "ERROR: version comparison failed for $NAME" >&2; exit 1; }

    if [ "$IS_NEWER" = "true" ]; then
      echo "CHANGED: $NAME $PUBLISHED_VERSION -> $VERSION at $RELATIVE_PATH" >&2
      RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$RELATIVE_PATH" '{name:$n,version:$v,path:$p}')")
    else
      echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
    fi
  else
    # Package not on npm (404 or error) - treat as new
    echo "NEW (unpublished): $NAME@$VERSION at $RELATIVE_PATH" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$RELATIVE_PATH" '{name:$n,version:$v,path:$p}')")
  fi
done < <(echo "$PACKAGES" | jq -c '.[]')

# Output results
if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
