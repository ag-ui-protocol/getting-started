#!/usr/bin/env bash
# scripts/release/detect-java-version-changes.sh
#
# Derives the set of Maven packages from scripts/release/release.config.json,
# reads the shared reactor version from the pom.xml each scope names as its
# versionSource, compares each artifact against Maven Central, and outputs a
# JSON array of packages that need publishing.
#
# Output format (stdout): [{"name":"java-core","version":"0.1.0","path":"sdks/community/java/ag-ui/core","file":"sdks/community/java/ag-ui/pom.xml","groupId":"com.ag-ui.community"}, ...]
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

MAVEN_PACKAGES=$(jq -c '
  [
    .scopes | to_entries[]
    | select(any(.value.packages[]; .ecosystem == "maven"))
    | .value.versionSource as $versionSource
    | .value.packages[]
    | select(.ecosystem == "maven")
    | {name: .name, path: .path, file: $versionSource, groupId: .groupId}
  ]
' "$CONFIG")

if [ -z "$MAVEN_PACKAGES" ] || [ "$MAVEN_PACKAGES" = "[]" ]; then
  echo "ERROR: release.config.json has no Maven packages" >&2
  exit 1
fi

# A missing groupId would silently build a wrong Maven Central URL, which 404s
# and reads as "never published" — i.e. it would publish over an existing
# artifact's namespace check instead of failing here.
if echo "$MAVEN_PACKAGES" | jq -e 'any(.[]; .groupId == null or .groupId == "")' >/dev/null; then
  echo "ERROR: every Maven package in release.config.json needs a \"groupId\"" >&2
  echo "$MAVEN_PACKAGES" | jq -r '.[] | select(.groupId == null or .groupId == "") | "  missing groupId: \(.name)"' >&2
  exit 1
fi

RESULTS=()
while read -r entry; do
  NAME=$(echo "$entry" | jq -r '.name')
  PKG_PATH=$(echo "$entry" | jq -r '.path')
  VERSION_FILE=$(echo "$entry" | jq -r '.file')
  GROUP_ID=$(echo "$entry" | jq -r '.groupId')
  POM="$REPO_ROOT/$VERSION_FILE"

  if [ ! -f "$POM" ]; then
    echo "ERROR: $VERSION_FILE not found for $NAME" >&2
    exit 1
  fi

  # Read the reactor version via a real XML parse. A pom carries <version>
  # elements for the parent, every dependency and every plugin, so a regex for
  # the "first <version>" reads the wrong one on most poms.
  VERSION=$(python3 - "$POM" <<'PY'
import sys
import xml.etree.ElementTree as ET

NS = "{http://maven.apache.org/POM/4.0.0}"
root = ET.parse(sys.argv[1]).getroot()
# Direct child only — never the <parent><version>.
version = root.findtext(f"{NS}version")
if version is None:
    version = root.findtext("version")
if version is None or not version.strip():
    print(f"ERROR: no project <version> in {sys.argv[1]}", file=sys.stderr)
    sys.exit(1)
print(version.strip())
PY
)

  GROUP_PATH=$(printf '%s' "$GROUP_ID" | tr '.' '/')
  RESPONSE=$(mktemp)
  STATUS=$(curl --compressed -sS --max-time 30 \
    -w '%{http_code}' \
    -o "$RESPONSE" \
    "https://repo1.maven.org/maven2/${GROUP_PATH}/${NAME}/maven-metadata.xml" || true)

  if [ "$STATUS" = "404" ]; then
    echo "NEW (unpublished): $NAME@$VERSION at $PKG_PATH" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$PKG_PATH" --arg f "$VERSION_FILE" --arg g "$GROUP_ID" '{name:$n,version:$v,path:$p,file:$f,groupId:$g}')")
    rm -f "$RESPONSE"
    continue
  fi

  if [ "$STATUS" != "200" ]; then
    echo "ERROR: Maven Central metadata lookup for $GROUP_ID:$NAME returned HTTP $STATUS" >&2
    if [ -s "$RESPONSE" ]; then
      cat "$RESPONSE" >&2
    fi
    rm -f "$RESPONSE"
    exit 1
  fi

  # maven-metadata.xml lists every published version under
  # <versioning><versions>. <latest>/<release> are unreliable (they can lag or
  # be absent), so take the max of the full list under semver ordering — the
  # same comparison the .NET lane makes against nuget.org.
  VERSION_LIST=$(mktemp)
  python3 - "$RESPONSE" > "$VERSION_LIST" <<'PY' || {
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
for node in root.iter("version"):
    if node.text and node.text.strip():
        print(node.text.strip())
PY
    echo "ERROR: could not parse maven-metadata.xml for $GROUP_ID:$NAME" >&2
    rm -f "$RESPONSE" "$VERSION_LIST"
    exit 1
  }
  rm -f "$RESPONSE"

  PUBLISHED_VERSION=$(cd "$REPO_ROOT" && node - "$VERSION_LIST" <<'NODE'
const fs = require("fs");
const semver = require("semver");
const versions = fs.readFileSync(process.argv[2], "utf8").split("\n").map((v) => v.trim());
const valid = versions.filter((version) => semver.valid(version));
if (valid.length === 0) process.exit(2);
valid.sort(semver.rcompare);
console.log(valid[0]);
NODE
) || {
    echo "ERROR: no semver-valid published versions for $GROUP_ID:$NAME" >&2
    rm -f "$VERSION_LIST"
    exit 1
  }
  rm -f "$VERSION_LIST"

  IS_NEWER=$(cd "$REPO_ROOT" && VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" node -e "
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
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$PKG_PATH" --arg f "$VERSION_FILE" --arg g "$GROUP_ID" '{name:$n,version:$v,path:$p,file:$f,groupId:$g}')")
  else
    echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
  fi
done < <(echo "$MAVEN_PACKAGES" | jq -c '.[]')

if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
