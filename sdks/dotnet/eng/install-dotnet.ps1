<#
.SYNOPSIS
    Provisions a repo-local .NET SDK under sdks/dotnet/.dotnet.
.DESCRIPTION
    Reads the pinned SDK version from global.json and installs it into a repo-local
    .dotnet directory using the official dotnet-install script. This keeps the build
    hermetic and independent of any machine-wide .NET installation, mirroring the
    provisioning approach used by dotnet/runtime, dotnet/aspnetcore and dotnet/extensions.

    Optionally installs an additional SDK channel/version (e.g. a .NET 11 preview)
    alongside the pinned SDK via -ExtraChannel / -ExtraVersion.
.PARAMETER ExtraChannel
    Optional additional Channel to install (e.g. "11.0", "11.0.1xx", "STS", "LTS").
.PARAMETER ExtraVersion
    Optional additional exact Version to install (e.g. "11.0.100-preview.5.25xxx").
.PARAMETER Quality
    Quality band used together with -ExtraChannel when -ExtraVersion is not supplied
    (e.g. "daily", "preview", "ga"). Defaults to "preview".
#>
[CmdletBinding()]
param(
    [string] $ExtraChannel,
    [string] $ExtraVersion,
    [string] $Quality = 'preview'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoDotnetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.dotnet'))
$globalJson = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\global.json'))

New-Item -ItemType Directory -Force -Path $repoDotnetRoot | Out-Null

$installScript = Join-Path $repoDotnetRoot 'dotnet-install.ps1'
if (-not (Test-Path $installScript)) {
    Write-Host "Downloading dotnet-install.ps1 ..."
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installScript -UseBasicParsing
}

# Install the SDK pinned in global.json.
Write-Host "Installing SDK pinned in $globalJson -> $repoDotnetRoot"
& $installScript -JSonFile $globalJson -InstallDir $repoDotnetRoot

# Optionally install an additional SDK (e.g. a preview channel for the union spike).
if ($ExtraVersion) {
    Write-Host "Installing additional SDK version $ExtraVersion -> $repoDotnetRoot"
    & $installScript -Version $ExtraVersion -InstallDir $repoDotnetRoot
}
elseif ($ExtraChannel) {
    Write-Host "Installing additional SDK channel $ExtraChannel (quality $Quality) -> $repoDotnetRoot"
    & $installScript -Channel $ExtraChannel -Quality $Quality -InstallDir $repoDotnetRoot
}

Write-Host "Done. Local SDK provisioned at $repoDotnetRoot"
