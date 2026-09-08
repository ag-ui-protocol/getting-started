#!/usr/bin/env bash
# scripts/release/verify-config-manifest-names.sh
#
# Verifies that the `name` declared for each package in
# scripts/release/release.config.json matches the actual package name in that
# package's on-disk manifest (package.json for TypeScript, pyproject.toml for
# Python — either PEP 621 `[project]` or poetry `[tool.poetry]`, or .csproj
# PackageId for .NET).
#
# Why this matters: release.config.json is the single source of truth that the
# version-bumper (prepare-release.ts), the dropdown guard, the nx allowlist
# guard, and the notify-job ecosystem map all key off. The `name` field is used
# in PR bodies, release-notes attribution and human-facing summaries. If it
# drifts from the real published name nobody notices until a release ships with
# the wrong label — exactly what happened with the langroid integration, whose
# config `name` was the underscore form `ag_ui_langroid` while its pyproject
# (and the actual PyPI distribution) is the hyphenated `ag-ui-langroid`.
#
# This guard cross-checks every config package `name` against its manifest at
# `path` and fails CI on any divergence.
#
# Note on `path`: each package's `path` is also validated transitively here —
# a missing/typo'd path surfaces as a missing manifest (loud failure below).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found" >&2
  exit 1
fi

# Emit one TSV line per package:
# "<scope>\t<name>\t<path>\t<ecosystem>\t<buildSystem>\t<groupId>".
PACKAGES=$(jq -r '
  .scopes | to_entries[]
  | .key as $s
  | .value.packages[]
  | [$s, .name, .path, .ecosystem, (.buildSystem // "-"), (.groupId // "-")] | @tsv
' "$CONFIG")

rc=0
while IFS=$'\t' read -r scope name path ecosystem build_system group_id; do
  [ -z "$scope" ] && continue

  if [ "$ecosystem" = "typescript" ]; then
    manifest="$REPO_ROOT/$path/package.json"
    if [ ! -f "$manifest" ]; then
      echo "ERROR: [$scope] $name: package.json not found at $path" >&2
      rc=1
      continue
    fi
    actual=$(jq -r '.name // empty' "$manifest")
  elif [ "$ecosystem" = "python" ]; then
    manifest="$REPO_ROOT/$path/pyproject.toml"
    if [ ! -f "$manifest" ]; then
      echo "ERROR: [$scope] $name: pyproject.toml not found at $path" >&2
      rc=1
      continue
    fi
    # Extract the name using tomllib (3.11+) or the tomli backport, mirroring
    # detect-py-version-changes.sh. uv/PEP 621 packages live under [project];
    # poetry packages under [tool.poetry].
    actual=$(MANIFEST="$manifest" BUILD_SYSTEM="$build_system" python3 -c "
import os, sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
with open(os.environ['MANIFEST'], 'rb') as f:
    cfg = tomllib.load(f)
bs = os.environ['BUILD_SYSTEM']
try:
    if bs == 'poetry':
        print(cfg['tool']['poetry']['name'])
    else:
        print(cfg['project']['name'])
except KeyError as e:
    print(f'ERROR: missing key {e} in {os.environ[\"MANIFEST\"]}', file=sys.stderr)
    sys.exit(1)
	") || { echo "ERROR: [$scope] $name: could not read name from $path/pyproject.toml" >&2; rc=1; continue; }
  elif [ "$ecosystem" = "dotnet" ]; then
    manifest=$(find "$REPO_ROOT/$path" -maxdepth 1 -name '*.csproj' -print -quit)
    if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then
      echo "ERROR: [$scope] $name: .csproj not found at $path" >&2
      rc=1
      continue
    fi
    actual=$(MANIFEST="$manifest" python3 -c "
import os, sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(os.environ['MANIFEST']).getroot()
    value = root.findtext('.//PackageId')
    if not value:
        raise KeyError('PackageId')
    print(value)
except Exception as e:
    print(f'ERROR: could not read PackageId from {os.environ[\"MANIFEST\"]}: {e}', file=sys.stderr)
    sys.exit(1)
") || { echo "ERROR: [$scope] $name: could not read PackageId from $path/*.csproj" >&2; rc=1; continue; }
  elif [ "$ecosystem" = "maven" ]; then
    manifest="$REPO_ROOT/$path/pom.xml"
    if [ ! -f "$manifest" ]; then
      echo "ERROR: [$scope] $name: pom.xml not found at $path" >&2
      rc=1
      continue
    fi
    # A Maven artifact is groupId:artifactId, and a module inherits its groupId
    # from the reactor's <parent> unless it declares its own. Both halves are
    # checked: a wrong groupId sends detect-java-version-changes.sh to a URL
    # that 404s, which reads as "never published".
    if [ "$group_id" = "-" ]; then
      echo "ERROR: [$scope] $name: maven packages must declare a \"groupId\" in release.config.json" >&2
      rc=1
      continue
    fi
    actual=$(MANIFEST="$manifest" python3 -c "
import os, sys
import xml.etree.ElementTree as ET
NS = '{http://maven.apache.org/POM/4.0.0}'
try:
    root = ET.parse(os.environ['MANIFEST']).getroot()
    def text(tag):
        return root.findtext(f'{NS}{tag}') or root.findtext(tag)
    artifact = text('artifactId')
    if not artifact:
        raise KeyError('artifactId')
    group = text('groupId')
    if not group:
        parent = root.find(f'{NS}parent')
        if parent is None:
            parent = root.find('parent')
        if parent is not None:
            group = parent.findtext(f'{NS}groupId') or parent.findtext('groupId')
    if not group:
        raise KeyError('groupId')
    print(artifact.strip())
    print(group.strip())
except Exception as e:
    print(f'ERROR: could not read coordinates from {os.environ[\"MANIFEST\"]}: {e}', file=sys.stderr)
    sys.exit(1)
") || { echo "ERROR: [$scope] $name: could not read coordinates from $path/pom.xml" >&2; rc=1; continue; }
    actual_group=$(printf '%s\n' "$actual" | sed -n '2p')
    actual=$(printf '%s\n' "$actual" | sed -n '1p')
    if [ "$group_id" != "$actual_group" ]; then
      echo "ERROR: [$scope] $name: release.config.json groupId '$group_id' != pom groupId '$actual_group' at $path" >&2
      rc=1
    fi
  else
    echo "ERROR: [$scope] $name: unknown ecosystem '$ecosystem'" >&2
    rc=1
    continue
  fi

  if [ -z "$actual" ]; then
    echo "ERROR: [$scope] $name: manifest at $path has no package name" >&2
    rc=1
    continue
  fi

  if [ "$name" != "$actual" ]; then
    echo "ERROR: [$scope] release.config.json name '$name' != manifest name '$actual' at $path" >&2
    rc=1
  fi
done <<< "$PACKAGES"

if [ "$rc" -ne 0 ]; then
  echo "" >&2
  echo "Fix: make each release.config.json package 'name' exactly match the name in" >&2
  echo "its manifest (package.json '.name', pyproject.toml [project]/[tool.poetry] name," >&2
  echo ".csproj PackageId, or pom.xml artifactId)." >&2
  exit 1
fi

echo "OK: every release.config.json package name matches its on-disk manifest"
exit 0
