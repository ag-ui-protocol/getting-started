#!/usr/bin/env bash
#
# Provisions a repo-local .NET SDK under sdks/dotnet/.dotnet.
#
# Reads the pinned SDK version from global.json and installs it into a repo-local
# .dotnet directory using the official dotnet-install script. This keeps the build
# hermetic and independent of any machine-wide .NET installation, mirroring the
# provisioning approach used by dotnet/runtime, dotnet/aspnetcore and dotnet/extensions.
#
# Optionally installs an additional SDK channel/version (e.g. a .NET 11 preview)
# alongside the pinned SDK via --extra-channel / --extra-version.
#
# Usage:
#   eng/install-dotnet.sh
#   eng/install-dotnet.sh --extra-channel 11.0 --quality preview
#   eng/install-dotnet.sh --extra-version 11.0.100-preview.5.25xxx

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dotnet_root="$(cd "$script_dir/.." && pwd)/.dotnet"
global_json="$(cd "$script_dir/.." && pwd)/global.json"

extra_channel=""
extra_version=""
quality="preview"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --extra-channel) extra_channel="$2"; shift 2 ;;
        --extra-version) extra_version="$2"; shift 2 ;;
        --quality) quality="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "$repo_dotnet_root"

install_script="$repo_dotnet_root/dotnet-install.sh"
if [[ ! -f "$install_script" ]]; then
    echo "Downloading dotnet-install.sh ..."
    curl -sSL 'https://dot.net/v1/dotnet-install.sh' -o "$install_script"
    chmod +x "$install_script"
fi

echo "Installing SDK pinned in $global_json -> $repo_dotnet_root"
"$install_script" --jsonfile "$global_json" --install-dir "$repo_dotnet_root"

if [[ -n "$extra_version" ]]; then
    echo "Installing additional SDK version $extra_version -> $repo_dotnet_root"
    "$install_script" --version "$extra_version" --install-dir "$repo_dotnet_root"
elif [[ -n "$extra_channel" ]]; then
    echo "Installing additional SDK channel $extra_channel (quality $quality) -> $repo_dotnet_root"
    "$install_script" --channel "$extra_channel" --quality "$quality" --install-dir "$repo_dotnet_root"
fi

echo "Done. Local SDK provisioned at $repo_dotnet_root"
