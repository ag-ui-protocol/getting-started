#!/usr/bin/env bash
#
# Verifies that every uv / CPython version literal under .github/workflows/ equals
# the version recorded in .github/python-toolchain.env, and that every setup-uv
# invocation takes its version from that pin rather than resolving one itself.
#
# Why this is needed: a workflow-level `env:` block cannot read a file, so each
# Python workflow repeats whichever of the two pins it uses. Repetition without a
# check is drift waiting to happen, and drift here is invisible — a job builds
# against a uv no green run ever used, and nothing looks wrong until it breaks.
#
# Why it is a text comparison and nothing more: an earlier version of this change
# shipped a checker that read the shell inside every `run:` block to find commands
# that might rewrite a lockfile. It reached ~1,400 lines, every review round found
# another shape that slipped past it, and it was removed. Comparing literals against
# two recorded values needs none of that machinery — no expression evaluation, no
# job-structure model, no `run:` parsing.
#
# What it does NOT catch, stated so nobody assumes otherwise:
#   - a pin that is correct here but wrong for the job (only a green run tells you)
#   - a workflow that installs uv by some route other than astral-sh/setup-uv
#   - a `version: ${{ env.UV_VERSION }}` added to some OTHER action to keep the
#     counts in step while smuggling in an unpinned setup-uv. Detecting that needs
#     the YAML structure this check deliberately does not model.

set -euo pipefail

cd "$(dirname "$0")/../.."

RECORD=.github/python-toolchain.env
WORKFLOWS=.github/workflows

# Only real workflow files. Without this every `grep -r` below also reads whatever
# else is sitting in the directory — a `.yml.orig` left by a bad merge, an editor's
# `.yml.bak` — and counts its pins twice. Found the hard way: the first version of
# this script reported 19/19 against a tree that has 17 declarations and 18
# invocations, because a test had left two backup files behind.
GREP_SCOPE=(-r --include='*.yml' --include='*.yaml' "$WORKFLOWS")

if [ ! -f "$RECORD" ]; then
  echo "::error::$RECORD not found — this check cannot verify anything without it"
  exit 1
fi

# shellcheck source=/dev/null
. "$RECORD"

: "${UV_VERSION:?$RECORD does not define UV_VERSION}"
: "${PYTHON_VERSION:?$RECORD does not define PYTHON_VERSION}"

status=0

# --- 1. Every declared literal agrees with the record ------------------------------
#
# Quote-tolerant on purpose: `UV_VERSION: 0.12.1` and `UV_VERSION: "0.12.1"` are the
# same pin, and a check that understood only one spelling would read the other as
# absent and pass over exactly the drift it exists to catch.
declarations=0
mismatches=""

while IFS= read -r hit; do
  file=${hit%%:*}
  rest=${hit#*:}
  lineno=${rest%%:*}
  decl=${rest#*:}

  key=$(printf '%s' "$decl" | sed -E 's/^[[:space:]]*([A-Z_]+):.*/\1/')
  value=$(printf '%s' "$decl" \
    | sed -E "s/^[[:space:]]*[A-Z_]+:[[:space:]]*//; s/[[:space:]]*$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/")

  case "$key" in
    UV_VERSION) expected=$UV_VERSION ;;
    PYTHON_VERSION) expected=$PYTHON_VERSION ;;
    *) continue ;;
  esac

  declarations=$((declarations + 1))
  if [ "$value" != "$expected" ]; then
    mismatches="${mismatches}  ${file}:${lineno}: ${key} is '${value}', ${RECORD} says '${expected}'"$'\n'
  fi
done < <(grep -nE '^[[:space:]]+(UV_VERSION|PYTHON_VERSION):' "${GREP_SCOPE[@]}" | sort)

# Refuse to pass vacuously. If the pattern matches nothing, every assertion below is
# trivially true — the one outcome a guard must never quietly produce.
if [ "$declarations" -eq 0 ]; then
  echo "::error::No UV_VERSION or PYTHON_VERSION declarations found under $WORKFLOWS/."
  echo "The pins were renamed or reindented and this check is now inspecting nothing."
  exit 1
fi

if [ -n "$mismatches" ]; then
  echo "::error::Workflow pins disagree with $RECORD"
  printf '%s' "$mismatches"
  echo
  echo "Either update the workflow to match the record, or move the pin properly:"
  echo "pick both versions from a newer green run, update $RECORD, update every"
  echo "declaration under $WORKFLOWS/, and record the new run id."
  status=1
fi

# --- 2. Every setup-uv invocation is pinned to that record ------------------------
#
# Check 1 only sees declarations that exist. A newly added setup-uv step that names no
# version at all — the state all 18 of these were in before this was pinned — declares
# nothing for it to compare, and would pass silently.
invocations=$(grep -c 'uses: astral-sh/setup-uv@' "${GREP_SCOPE[@]}" | awk -F: '{ n += $2 } END { print n + 0 }')
pinned=$(grep -c 'version: ${{ env.UV_VERSION }}' "${GREP_SCOPE[@]}" | awk -F: '{ n += $2 } END { print n + 0 }')

if [ "$invocations" -eq 0 ]; then
  echo "::error::No astral-sh/setup-uv invocations found under $WORKFLOWS/ — the search is wrong, not the repo"
  exit 1
fi

if [ "$invocations" -ne "$pinned" ]; then
  echo "::error::${invocations} setup-uv invocation(s) but ${pinned} pinned to \${{ env.UV_VERSION }}"
  echo "Every setup-uv must take 'version: \${{ env.UV_VERSION }}'. Unpinned invocations:"
  for wf in "$WORKFLOWS"/*.yml "$WORKFLOWS"/*.yaml; do
    [ -e "$wf" ] || continue
    uses=$(grep -c 'uses: astral-sh/setup-uv@' "$wf" || true)
    has=$(grep -c 'version: ${{ env.UV_VERSION }}' "$wf" || true)
    [ "$uses" -ne "$has" ] && echo "  ${wf}: ${uses} invocation(s), ${has} pinned"
  done
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "All ${declarations} pin declaration(s) match ${RECORD} (uv ${UV_VERSION}, CPython ${PYTHON_VERSION})."
  echo "All ${invocations} setup-uv invocation(s) resolve their version from it."
fi

exit "$status"
