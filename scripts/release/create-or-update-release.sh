#!/usr/bin/env bash
# scripts/release/create-or-update-release.sh
#
# Creates or updates a daily GitHub Release with published package info and
# the per-package release notes approved on the release PR (read from each
# package's committed CHANGELOG.md via extract-changelog-entry.py).
#
# Usage: ./create-or-update-release.sh <ecosystem> <packages-json>
#   ecosystem: "typescript", "python", "dotnet", or "maven"
#   packages-json: JSON array string of published packages
#     TS format:  [{"name":"@ag-ui/core","version":"0.0.49","path":"..."}]
#     Py format:  [{"name":"ag-ui-protocol","version":"0.1.15","dir":"..."}]
#     .NET format: [{"name":"AGUI.Client","version":"0.1.0","path":"..."}]
#     Maven format: [{"name":"java-core","version":"0.1.0","path":"...","groupId":"com.ag-ui.community"}]
#
# Requires: gh CLI authenticated with contents:write permission
# Environment: DRY_RUN=true to skip actual release creation

set -euo pipefail

ECOSYSTEM="${1:?Usage: $0 <ecosystem> <packages-json>}"
PACKAGES_JSON="${2:?Usage: $0 <ecosystem> <packages-json>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Validate the payload BEFORE any loop reads it. `while read < <(jq ...)` runs
# jq in a process substitution, whose failure `set -euo pipefail` does not
# propagate: malformed JSON would make every loop iterate zero times and the
# script would exit 0 having published an empty section.
if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: packages-json is not a JSON array: ${PACKAGES_JSON:0:200}" >&2
  exit 1
fi
# `all(.[]; ...)` is vacuously true for [], which would reproduce exactly the
# zero-iteration success this guard exists to prevent.
if ! jq -e 'length > 0' >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: packages-json is empty; nothing to publish" >&2
  exit 1
fi
if ! jq -e 'all(.[]; (.name | type == "string") and (.version | type == "string"))' \
  >/dev/null 2>&1 <<<"$PACKAGES_JSON"; then
  echo "ERROR: every packages-json entry needs string .name and .version: ${PACKAGES_JSON:0:200}" >&2
  exit 1
fi

TAG="release/$(date -u +%Y-%m-%d)"
TITLE="Release $(date -u +%Y-%m-%d)"
TIMESTAMP=$(date -u +%H:%M:%S)

# Per-package release notes, read from the CHANGELOG.md entry that was
# reviewed and approved on the release PR (the merged files are the source of
# truth — never the PR body). A missing entry is stated rather than silently
# omitted, so a failed or skipped generation stays visible to consumers.
#
# Each block ends with an invisible sentinel comment. Presence checks (the
# append/retry path here, and reconcile-release.sh) key on that sentinel
# rather than on the install-table row: approved notes are arbitrary Markdown
# and can legitimately contain a table row that LOOKS like "| name | version |",
# which would otherwise make an unpublished package appear already recorded.
published_sentinel() {
  printf '<!-- ag-ui-published: %s@%s -->' "$1" "$2"
}

# A fault gets a DIFFERENT marker, deliberately not the published sentinel:
# presence checks key on "published" only, so once the underlying fault is
# fixed reconcile still sees the package as missing and repairs it. Marking a
# fault as published would freeze the placeholder into the release forever.
unreadable_marker() {
  printf '<!-- ag-ui-unreadable: %s@%s -->' "$1" "$2"
}

# Exit 3 is the extractor's "this version has no entry" — an expected absence
# worth stating in the body. ANY other non-zero status is a fault (unreadable
# config, undecodable changelog, broken interpreter) and must NOT be laundered
# into the same reassuring sentence: that publishes a lie to consumers and,
# because the block still carries a sentinel, reconcile treats the package as
# done and never retries. Faults get their own text plus a workflow annotation
# on stderr, which is where a human will actually see them.
readonly EXTRACT_NO_ENTRY=3

# notes_block's stdout IS the block, so the extraction status travels out of
# band — through a FILE, not a variable: callers invoke notes_block inside a
# command substitution, and a variable set in that subshell never reaches the
# parent. Callers need the status because an over-budget block is REPLACED
# with a pointer, and that pointer must keep a fault retryable instead of
# stamping it "published".
NOTES_STATUS_FILE="$(mktemp)"
trap 'rm -f "$NOTES_STATUS_FILE"' EXIT

notes_status() {
  cat "$NOTES_STATUS_FILE" 2>/dev/null || echo 0
}

notes_block() {
  local name="$1" version="$2" entry status stderr_file
  stderr_file=$(mktemp)
  set +e
  entry=$(python3 "$SCRIPT_DIR/extract-changelog-entry.py" "$name" "$version" --demote 2 2>"$stderr_file")
  status=$?
  set -e
  printf '%s' "$status" > "$NOTES_STATUS_FILE"

  # NOTE: marker-looking comments inside the entry are neutralised by
  # extract-changelog-entry.py, not here. Doing it in bash is not portable:
  # bash 5.2 enables patsub_replacement, where an unquoted `&` in a
  # ${v//a/b} replacement expands to the matched text, and the spellings that
  # work on 5.2 leave literal backslashes or quotes on the bash 3.2 that ships
  # with macOS.

  if [ "$status" -eq 0 ]; then
    printf '#### %s@%s\n\n%s\n\n%s\n' "$name" "$version" "$entry" "$(published_sentinel "$name" "$version")"
  elif [ "$status" -eq "$EXTRACT_NO_ENTRY" ]; then
    printf '#### %s@%s\n\n_No release notes were approved for this version — the changelog entry is missing._\n\n%s\n' "$name" "$version" "$(published_sentinel "$name" "$version")"
  else
    local detail
    detail=$(tr '\n' ' ' <"$stderr_file" | cut -c1-300)
    echo "::warning title=Release notes unreadable::${name}@${version}: extract-changelog-entry.py exited ${status}: ${detail}" >&2
    echo "ERROR: could not read release notes for ${name}@${version} (exit ${status}): ${detail}" >&2
    printf '#### %s@%s\n\n_Release notes could not be read from this package'\''s `CHANGELOG.md` — see the publish workflow run for the error. The entry in the repository is authoritative._\n\n%s\n' "$name" "$version" "$(unreadable_marker "$name" "$version")"
  fi
  rm -f "$stderr_file"
}

# Presence test for a package in an existing release body. Bodies written by
# this script version carry sentinels — key on those. A body without any
# sentinel predates them (created before this change landed), so fall back to
# the legacy row-key match rather than double-appending everything.
# "Sentinel era" is detected from EITHER marker, so a body whose only block is
# a fault placeholder is still read in sentinel mode — otherwise it would fall
# back to row matching, find the install row this script itself wrote, and
# call the package recorded. Only the published sentinel counts as recorded.
package_recorded() {
  local body="$1" name="$2" version="$3"
  if grep -Fq "<!-- ag-ui-" <<<"$body"; then
    grep -Fq "$(published_sentinel "$name" "$version")" <<<"$body"
  else
    grep -Fq "| ${name} | ${version} |" <<<"$body"
  fi
}

# Build the section for this ecosystem using real newlines (not \n literals)
NL=$'\n'
if [ "$ECOSYSTEM" = "typescript" ]; then
  SECTION="### TypeScript (npm) - published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    SECTION+="| ${NAME} | ${VERSION} | \`npm install ${NAME}@${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
elif [ "$ECOSYSTEM" = "python" ]; then
  SECTION="### Python (PyPI) - published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    SECTION+="| ${NAME} | ${VERSION} | \`pip install ${NAME}==${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
elif [ "$ECOSYSTEM" = "dotnet" ]; then
  SECTION="### .NET (NuGet) - published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    SECTION+="| ${NAME} | ${VERSION} | \`dotnet add package ${NAME} --version ${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
elif [ "$ECOSYSTEM" = "maven" ]; then
  # Gradle-style coordinates rather than a <dependency> block: the install cell
  # has to stay on one line inside the table.
  SECTION="### Java (Maven Central) - published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    GROUP_ID=$(echo "$pkg" | jq -r '.groupId')
    SECTION+="| ${NAME} | ${VERSION} | \`${GROUP_ID}:${NAME}:${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
else
  echo "ERROR: Unknown ecosystem '$ECOSYSTEM'. Use 'typescript', 'python', 'dotnet', or 'maven'." >&2
  exit 1
fi

# The approved notes follow the install table, one block per package.
#
# Bounded, because this runs AFTER packages are published and tags are pushed:
# GitHub rejects a release body over ~125,000 characters, and a rejected
# `gh release create/edit` at that point leaves no GitHub Release at all for an
# already-published release. When the budget runs out the remaining packages
# keep their install rows and sentinels (so presence checks and reconcile stay
# correct) and point at the tag's CHANGELOG.md instead of inlining prose.
RELEASE_BODY_BUDGET=110000

# The pointer that replaces an over-budget block. Applied ONLY when the
# extractor succeeded, i.e. when there are real notes worth omitting: the
# missing-entry and fault blocks are one sentence each, so replacing them saves
# nothing and destroys the disclosure — "read them in CHANGELOG.md" would point
# at notes that do not exist, or hide that they could not be read at all. The
# marker is still selected defensively in case a future caller needs it.
budget_pointer_block() {
  local name="$1" version="$2" marker status
  status="$(notes_status)"
  if [ "$status" -eq 0 ] || [ "$status" -eq "$EXTRACT_NO_ENTRY" ]; then
    marker="$(published_sentinel "$name" "$version")"
  else
    marker="$(unreadable_marker "$name" "$version")"
  fi
  printf '#### %s@%s\n\n_Notes omitted to stay within GitHub'\''s release-body limit — read them in this package'\''s `CHANGELOG.md` at tag `%s`._\n\n%s\n' \
    "$name" "$version" "${name}@${version}" "$marker"
}

SECTION+="${NL}"
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  BLOCK="$(notes_block "$NAME" "$VERSION")${NL}${NL}"
  if [ "$(notes_status)" -eq 0 ] &&
    [ $((${#SECTION} + ${#BLOCK})) -gt "$RELEASE_BODY_BUDGET" ]; then
    BLOCK="$(budget_pointer_block "$NAME" "$VERSION")${NL}${NL}"
    echo "::warning title=Release notes omitted::${NAME}@${VERSION}: release body budget reached; notes replaced with a pointer to CHANGELOG.md" >&2
  fi
  SECTION+="$BLOCK"
done < <(echo "$PACKAGES_JSON" | jq -c '.[]')

NEW_SECTION="${NL}${SECTION}"

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY RUN: Would create/update release $TAG with:" >&2
  echo "$NEW_SECTION" >&2
  exit 0
fi

# Try to get existing release - retry logic for race condition
MAX_RETRIES=3
for i in $(seq 1 $MAX_RETRIES); do
  if gh release view "$TAG" &>/dev/null; then
    # Release exists - append our section, but skip rows already present so
    # a retry after a partial failure doesn't create a duplicate section.
    EXISTING_BODY=$(gh release view "$TAG" --json body -q .body)

    # Determine which rows are genuinely new vs. already present.
    APPEND_SECTION=""
    APPEND_NOTES=""
    APPEND_ROWS=0
    while read -r pkg; do
      NAME=$(echo "$pkg" | jq -r '.name')
      VERSION=$(echo "$pkg" | jq -r '.version')
      # Maven only; empty for the other ecosystems.
      GROUP_ID=$(echo "$pkg" | jq -r '.groupId // empty')
      if package_recorded "$EXISTING_BODY" "$NAME" "$VERSION"; then
        echo "Row for ${NAME}@${VERSION} already present in release body; skipping" >&2
      elif grep -Fq "$(unreadable_marker "$NAME" "$VERSION")" <<<"$EXISTING_BODY"; then
        # A previous attempt recorded this package as unreadable, deliberately
        # without the published marker so it stays retryable. It already has an
        # install row and a placeholder, so re-adding either would duplicate
        # them on every reconcile. Retry the extraction only: if it still
        # fails there is nothing new to say, and if it now succeeds the real
        # notes are appended without a second row.
        RETRY_BLOCK="$(notes_block "$NAME" "$VERSION")${NL}${NL}"
        RETRY_STATUS="$(notes_status)"
        # Exit 3 means the fault is GONE and the version simply has no entry —
        # a resolved state carrying the published marker. Treating it as "still
        # unreadable" would keep the false placeholder and make reconcile retry
        # this package on every future run, forever.
        if [ "$RETRY_STATUS" -ne 0 ] && [ "$RETRY_STATUS" -ne "$EXTRACT_NO_ENTRY" ]; then
          echo "${NAME}@${VERSION} is still unreadable; not duplicating its placeholder" >&2
        else
          USED=$((${#EXISTING_BODY} + ${#APPEND_SECTION} + ${#APPEND_NOTES}))
          if [ "$RETRY_STATUS" -eq 0 ] &&
            [ $((USED + ${#RETRY_BLOCK})) -gt "$RELEASE_BODY_BUDGET" ]; then
            RETRY_BLOCK="$(budget_pointer_block "$NAME" "$VERSION")${NL}${NL}"
            echo "::warning title=Release notes omitted::${NAME}@${VERSION}: release body budget reached; notes replaced with a pointer to CHANGELOG.md" >&2
          fi
          echo "Repaired release notes for ${NAME}@${VERSION}; appending them" >&2
          APPEND_NOTES+="$RETRY_BLOCK"
          APPEND_ROWS=$((APPEND_ROWS + 1))
        fi
      else
        case "$ECOSYSTEM" in
          typescript) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`npm install ${NAME}@${VERSION}\` |${NL}" ;;
          python) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`pip install ${NAME}==${VERSION}\` |${NL}" ;;
          dotnet) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`dotnet add package ${NAME} --version ${VERSION}\` |${NL}" ;;
          maven) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`${GROUP_ID}:${NAME}:${VERSION}\` |${NL}" ;;
        esac
        # The budget must account for the body ALREADY on the release: this
        # path runs once per ecosystem against the same daily release, so the
        # last lane is the one that would push it over GitHub's limit — and it
        # fails after that lane's packages are published and tagged.
        BLOCK="$(notes_block "$NAME" "$VERSION")${NL}${NL}"
        USED=$((${#EXISTING_BODY} + ${#APPEND_SECTION} + ${#APPEND_NOTES}))
        if [ "$(notes_status)" -eq 0 ] &&
          [ $((USED + ${#BLOCK})) -gt "$RELEASE_BODY_BUDGET" ]; then
          BLOCK="$(budget_pointer_block "$NAME" "$VERSION")${NL}${NL}"
          echo "::warning title=Release notes omitted::${NAME}@${VERSION}: release body budget reached; notes replaced with a pointer to CHANGELOG.md" >&2
        fi
        APPEND_NOTES+="$BLOCK"
        APPEND_ROWS=$((APPEND_ROWS + 1))
      fi
    done < <(echo "$PACKAGES_JSON" | jq -c '.[]')

    if [ "$APPEND_ROWS" -eq 0 ]; then
      echo "All ${ECOSYSTEM} rows already present in release $TAG; no update needed" >&2
      exit 0
    fi

    case "$ECOSYSTEM" in
      typescript) HEADER="### TypeScript (npm) - published at ${TIMESTAMP} UTC${NL}| Package | Version | Install |${NL}|---------|---------|--------|${NL}" ;;
      python) HEADER="### Python (PyPI) - published at ${TIMESTAMP} UTC${NL}| Package | Version | Install |${NL}|---------|---------|--------|${NL}" ;;
      dotnet) HEADER="### .NET (NuGet) - published at ${TIMESTAMP} UTC${NL}| Package | Version | Install |${NL}|---------|---------|--------|${NL}" ;;
      maven) HEADER="### Java (Maven Central) - published at ${TIMESTAMP} UTC${NL}| Package | Version | Install |${NL}|---------|---------|--------|${NL}" ;;
    esac
    UPDATED_BODY="${EXISTING_BODY}${NL}${HEADER}${APPEND_SECTION}${NL}${APPEND_NOTES}"
    echo "$UPDATED_BODY" | gh release edit "$TAG" --notes-file -
    echo "Updated existing release $TAG with $APPEND_ROWS new $ECOSYSTEM row(s)" >&2
    exit 0
  else
    # Try to create new release
    BODY="## Packages Published${NEW_SECTION}"
    CREATE_OUTPUT=$(echo "$BODY" | gh release create "$TAG" --title "$TITLE" --notes-file - 2>&1) && {
      echo "Created new release $TAG with $ECOSYSTEM packages" >&2
      exit 0
    }
    if echo "$CREATE_OUTPUT" | grep -qi "already exists"; then
      echo "Race condition on release creation (attempt $i/$MAX_RETRIES), retrying..." >&2
      sleep 2
    else
      echo "ERROR: gh release create failed: $CREATE_OUTPUT" >&2
      exit 1
    fi
  fi
done

echo "ERROR: Failed to create or update release after $MAX_RETRIES attempts" >&2
exit 1
