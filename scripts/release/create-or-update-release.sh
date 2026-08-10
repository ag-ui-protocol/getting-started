#!/usr/bin/env bash
# scripts/release/create-or-update-release.sh
#
# Creates or updates a daily GitHub Release with published package info.
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

TAG="release/$(date -u +%Y-%m-%d)"
TITLE="Release $(date -u +%Y-%m-%d)"
TIMESTAMP=$(date -u +%H:%M:%S)

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
    APPEND_ROWS=0
    while read -r pkg; do
      NAME=$(echo "$pkg" | jq -r '.name')
      VERSION=$(echo "$pkg" | jq -r '.version')
      # Maven only; empty for the other ecosystems.
      GROUP_ID=$(echo "$pkg" | jq -r '.groupId // empty')
      ROW_KEY="| ${NAME} | ${VERSION} |"
      if grep -Fq "$ROW_KEY" <<<"$EXISTING_BODY"; then
        echo "Row for ${NAME}@${VERSION} already present in release body; skipping" >&2
      else
        case "$ECOSYSTEM" in
          typescript) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`npm install ${NAME}@${VERSION}\` |${NL}" ;;
          python) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`pip install ${NAME}==${VERSION}\` |${NL}" ;;
          dotnet) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`dotnet add package ${NAME} --version ${VERSION}\` |${NL}" ;;
          maven) APPEND_SECTION+="| ${NAME} | ${VERSION} | \`${GROUP_ID}:${NAME}:${VERSION}\` |${NL}" ;;
        esac
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
    UPDATED_BODY="${EXISTING_BODY}${NL}${HEADER}${APPEND_SECTION}"
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
