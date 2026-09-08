#!/usr/bin/env bash
# scripts/release/detect-dotnet-version-changes.sh
#
# Derives the set of .NET packages from scripts/release/release.config.json,
# reads the shared VersionPrefix from Directory.Build.props, compares each
# package against nuget.org, and outputs a JSON array of packages that need
# publishing.
#
# Output format (stdout): [{"name":"AGUI.Client","version":"0.1.0","path":"sdks/dotnet/src/AGUI.Client","file":"sdks/dotnet/Directory.Build.props"}, ...]
# Logs go to stderr.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found" >&2
  exit 1
fi

if ! (cd "$REPO_ROOT" && node -e "require('semver')") 2>/dev/null; then
  echo "ERROR: 'semver' module not resolvable from $REPO_ROOT." >&2
  echo "       Run 'pnpm install --frozen-lockfile' before this script." >&2
  exit 1
fi

DOTNET_PACKAGES=$(jq -c '
  [
    .scopes | to_entries[]
    | select(any(.value.packages[]; .ecosystem == "dotnet"))
    | .value.versionSource as $versionSource
    | .value.packages[]
    | select(.ecosystem == "dotnet")
    | {name: .name, path: .path, file: $versionSource}
  ]
' "$CONFIG")

if [ -z "$DOTNET_PACKAGES" ] || [ "$DOTNET_PACKAGES" = "[]" ]; then
  echo "ERROR: release.config.json has no .NET packages" >&2
  exit 1
fi

RESULTS=()
while read -r entry; do
  NAME=$(echo "$entry" | jq -r '.name')
  PKG_PATH=$(echo "$entry" | jq -r '.path')
  VERSION_FILE=$(echo "$entry" | jq -r '.file')
  PROPS="$REPO_ROOT/$VERSION_FILE"

  if [ ! -f "$PROPS" ]; then
    echo "ERROR: $VERSION_FILE not found for $NAME" >&2
    exit 1
  fi

  VERSION=$(python3 - "$PROPS" <<'PY'
import re
import sys
content = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"<VersionPrefix(?:\s+[^>]*)?>([^<]+)</VersionPrefix>", content)
if not match:
    print(f"ERROR: missing VersionPrefix in {sys.argv[1]}", file=sys.stderr)
    sys.exit(1)
print(match.group(1))
PY
)

  PACKAGE_ID=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
  RESPONSE=$(mktemp)
  STATUS=$(curl --compressed -sS --max-time 30 \
    -w '%{http_code}' \
    -o "$RESPONSE" \
    "https://api.nuget.org/v3/registration5-gz-semver2/${PACKAGE_ID}/index.json" || true)

  if [ "$STATUS" = "404" ]; then
    echo "NEW (unpublished): $NAME@$VERSION at $PKG_PATH" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$PKG_PATH" --arg f "$VERSION_FILE" '{name:$n,version:$v,path:$p,file:$f}')")
    rm -f "$RESPONSE"
    continue
  fi

  if [ "$STATUS" != "200" ]; then
    echo "ERROR: nuget.org registration lookup for $NAME returned HTTP $STATUS" >&2
    if [ -s "$RESPONSE" ]; then
      cat "$RESPONSE" >&2
    fi
    rm -f "$RESPONSE"
    exit 1
  fi

  PUBLISHED_VERSION=$(node - "$RESPONSE" <<'NODE'
const fs = require("fs");
const semver = require("semver");
const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const versions = [];
function visit(value) {
  if (!value || typeof value !== "object") return;
  if (value.catalogEntry?.version) versions.push(value.catalogEntry.version);
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
  } else {
    for (const item of Object.values(value)) visit(item);
  }
}
visit(doc);
const valid = versions.filter((version) => semver.valid(version));
if (valid.length === 0) process.exit(2);
valid.sort(semver.rcompare);
console.log(valid[0]);
NODE
) || {
    echo "ERROR: could not parse published NuGet versions for $NAME" >&2
    rm -f "$RESPONSE"
    exit 1
  }
  rm -f "$RESPONSE"

  IS_NEWER=$(VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" node -e "
    const semver = require('semver');
    const local = process.env.VERSION;
    const pub = process.env.PUBLISHED;
    if (!semver.valid(local) || !semver.valid(pub)) {
      console.error('ERROR: invalid semver: local=' + local + ' published=' + pub);
      process.exit(1);
    }
    console.log(semver.gt(local, pub) ? 'true' : 'false');
  ") || { echo "ERROR: version comparison failed for $NAME" >&2; exit 1; }

  if [ "$IS_NEWER" = "true" ]; then
    echo "CHANGED: $NAME $PUBLISHED_VERSION -> $VERSION at $PKG_PATH" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$PKG_PATH" --arg f "$VERSION_FILE" '{name:$n,version:$v,path:$p,file:$f}')")
  else
    echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
  fi
done < <(echo "$DOTNET_PACKAGES" | jq -c '.[]')

if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
