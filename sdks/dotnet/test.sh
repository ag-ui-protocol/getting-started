#!/usr/bin/env bash
#
# Runs the full AG-UI .NET SDK test suite with one command.
#
# Runs, in order:
#   1. Unit tests        — AGUI.{Abstractions,Client,Formatting,Protobuf,Server}.UnitTests
#   2. Integration tests — AGUI.Hosting.AspNetCore.IntegrationTests (SSE + protobuf transports)
#   3. Cross-language    — Phase 1 (TS HttpAgent -> C# server, Vitest) and
#                          Phase 2 (C# AGUIChatClient -> TS fake server, xUnit)
#
# The cross-language phases need Node + pnpm.
#
# Usage:
#   ./test.sh [--debug] [--no-cross-language] [--no-install]
#
#   --debug              Build/test in Debug instead of Release.
#   --no-cross-language  Skip the cross-language suites (no Node/pnpm needed).
#   --no-install         Skip 'pnpm install' (assume the workspace is installed).
set -euo pipefail

CONFIGURATION="Release"
RUN_CROSS_LANGUAGE=1
RUN_INSTALL=1

for arg in "$@"; do
  case "$arg" in
    --debug) CONFIGURATION="Debug" ;;
    --no-cross-language) RUN_CROSS_LANGUAGE=0 ;;
    --no-install) RUN_INSTALL=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
DOTNET_DIR="$REPO_ROOT/sdks/dotnet"
cd "$DOTNET_DIR"

# One unit-test project per src/ package.
UNIT_PROJECTS=(
  tests/AGUI.Abstractions.UnitTests
  tests/AGUI.Client.UnitTests
  tests/AGUI.Formatting.UnitTests
  tests/AGUI.Protobuf.UnitTests
  tests/AGUI.Server.UnitTests
)

for project in "${UNIT_PROJECTS[@]}"; do
  echo "==> unit: $project"
  dotnet test "$project" -c "$CONFIGURATION"
done

echo "==> integration: tests/AGUI.Hosting.AspNetCore.IntegrationTests"
dotnet test tests/AGUI.Hosting.AspNetCore.IntegrationTests -c "$CONFIGURATION"

if [[ "$RUN_CROSS_LANGUAGE" == "1" ]]; then
  if [[ "$RUN_INSTALL" == "1" ]]; then
    echo "==> pnpm install (cross-language workspace deps)"
    (cd "$REPO_ROOT" && pnpm install --frozen-lockfile)
  fi

  echo "==> cross-language phase 1 (TS client -> C# server) [vitest]"
  (cd "$REPO_ROOT" && pnpm --filter '@ag-ui/cross-language-tests' test)

  echo "==> cross-language phase 2 (C# client -> TS server)"
  dotnet test tests/AGUI.CrossLanguage.IntegrationTests -c "$CONFIGURATION"
fi

echo "All AG-UI .NET SDK tests passed."
