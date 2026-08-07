#!/usr/bin/env bash
#
# Provisions a repo-local .NET SDK (if needed) and builds the AG-UI .NET SDK.
#
# Ensures sdks/dotnet/.dotnet contains the SDK pinned in global.json, then runs
# `dotnet build` (or `dotnet test` with --test) against AGUI.slnx using that local
# SDK only (DOTNET_MULTILEVEL_LOOKUP=0). Any extra arguments are forwarded to the
# underlying dotnet command.
#
# Usage:
#   ./build.sh
#   ./build.sh --test
#   ./build.sh --configuration Release -- -p:NuGetAudit=false

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dotnet_root="$script_dir/.dotnet"

configuration="Debug"
command="build"
skip_provision="false"
extra_args=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --configuration|-c) configuration="$2"; shift 2 ;;
        --test) command="test"; shift ;;
        --skip-provision) skip_provision="true"; shift ;;
        --) shift; extra_args+=("$@"); break ;;
        *) extra_args+=("$1"); shift ;;
    esac
done

if [[ "$skip_provision" != "true" ]]; then
    "$script_dir/eng/install-dotnet.sh"
fi

dotnet_exe="$dotnet_root/dotnet"
if [[ ! -x "$dotnet_exe" ]]; then
    echo "Local dotnet not found at $dotnet_exe. Run without --skip-provision first." >&2
    exit 1
fi

export DOTNET_ROOT="$dotnet_root"
export PATH="$dotnet_root:$PATH"
export DOTNET_MULTILEVEL_LOOKUP=0
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

solution="$script_dir/AGUI.slnx"
echo "dotnet $command $solution -c $configuration ${extra_args[*]:-}"
# `${extra_args[@]}` unquoted-by-default is an unbound-variable error under
# `set -u` when no extra args were passed, on bash 3.2 (what macOS ships) and
# any bash before 4.4 — so the documented no-argument `./build.sh` aborted with
# "extra_args[@]: unbound variable" before reaching dotnet. The `+` expansion
# yields nothing at all when the array is empty and is safe on every version.
exec "$dotnet_exe" "$command" "$solution" -c "$configuration" ${extra_args[@]+"${extra_args[@]}"}
