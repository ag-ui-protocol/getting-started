#!/usr/bin/env bash
# scripts/release/reconcile-release.sh
#
# Final safety net: ensures a daily GitHub Release exists for today's date and
# contains an entry for every tag we just pushed. Handles the partial-failure
# case where tags were pushed but `gh release create/edit` did not complete.
#
# Usage: ./reconcile-release.sh <ecosystem> <packages-json>
#
# This is idempotent: if the release already has all required rows, it does
# nothing. Otherwise it invokes create-or-update-release.sh to append the
# missing content.

set -euo pipefail

ECOSYSTEM="${1:?Usage: $0 <ecosystem> <packages-json>}"
PACKAGES_JSON="${2:?Usage: $0 <ecosystem> <packages-json>}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Validate before any loop: `while read < <(jq ...)` hides a jq failure from
# `set -euo pipefail`, so malformed JSON would iterate zero times and this
# script would report "nothing to reconcile" for a broken release.
if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: packages-json is not a JSON array: ${PACKAGES_JSON:0:200}" >&2
  exit 1
fi
# `all(.[]; ...)` is vacuously true for [], which would report "nothing to
# reconcile" for an empty payload instead of flagging the caller's mistake.
if ! jq -e 'length > 0' >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: packages-json is empty; nothing to reconcile" >&2
  exit 1
fi
if ! jq -e 'all(.[]; (.name | type == "string") and (.version | type == "string"))' \
  >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: every packages-json entry needs string .name and .version: ${PACKAGES_JSON:0:200}" >&2
  exit 1
fi

TAG="release/$(date -u +%Y-%m-%d)"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG does not exist; creating via create-or-update-release.sh" >&2
  bash "$REPO_ROOT/scripts/release/create-or-update-release.sh" "$ECOSYSTEM" "$PACKAGES_JSON"
  exit $?
fi

BODY=$(gh release view "$TAG" --json body -q .body || true)

# Mirrors package_recorded in create-or-update-release.sh: bodies written by
# the current script version carry per-package marker comments — key on those,
# because approved release notes are arbitrary Markdown and can contain a table
# row that LOOKS like "| name | version |". A body without ANY ag-ui marker
# predates them; fall back to the legacy row-key match.
#
# Only the "published" marker counts as recorded. A package whose notes could
# not be read carries "ag-ui-unreadable" instead, so it is still reported as
# missing here and gets repaired once the underlying fault is fixed.
MISSING=0
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  if grep -Fq "<!-- ag-ui-" <<<"$BODY"; then
    RECORDED_KEY="<!-- ag-ui-published: ${NAME}@${VERSION} -->"
  else
    RECORDED_KEY="| ${NAME} | ${VERSION} |"
  fi
  if ! grep -Fq "$RECORDED_KEY" <<<"$BODY"; then
    echo "Release $TAG missing entry for ${NAME}@${VERSION}" >&2
    MISSING=1
  fi
done < <(echo "$PACKAGES_JSON" | jq -c '.[]')

if [ "$MISSING" -ne 0 ]; then
  echo "Reconciling release $TAG via create-or-update-release.sh" >&2
  bash "$REPO_ROOT/scripts/release/create-or-update-release.sh" "$ECOSYSTEM" "$PACKAGES_JSON"
else
  echo "Release $TAG already has rows for all published packages; nothing to reconcile" >&2
fi
