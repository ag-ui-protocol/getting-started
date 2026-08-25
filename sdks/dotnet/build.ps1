<#
.SYNOPSIS
    Provisions a repo-local .NET SDK (if needed) and builds the AG-UI .NET SDK.
.DESCRIPTION
    Ensures sdks/dotnet/.dotnet contains the SDK pinned in global.json, then runs
    `dotnet build` (or `dotnet test` with -Test) against AGUI.slnx using that local
    SDK only (DOTNET_MULTILEVEL_LOOKUP=0). Any extra arguments are forwarded to the
    underlying dotnet command.
.EXAMPLE
    .\build.ps1
.EXAMPLE
    .\build.ps1 -Test
.EXAMPLE
    .\build.ps1 -Configuration Release -- -p:NuGetAudit=false
#>
[CmdletBinding()]
param(
    [string] $Configuration = 'Debug',
    [switch] $Test,
    [switch] $SkipProvision,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ExtraArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dotnetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.dotnet'))

if (-not $SkipProvision) {
    & (Join-Path $PSScriptRoot 'eng\install-dotnet.ps1')
}

$dotnet = Join-Path $dotnetRoot 'dotnet.exe'
if (-not (Test-Path $dotnet)) {
    throw "Local dotnet not found at $dotnet. Run without -SkipProvision first."
}

$env:DOTNET_ROOT = $dotnetRoot
$env:PATH = "$dotnetRoot$([System.IO.Path]::PathSeparator)$env:PATH"
$env:DOTNET_MULTILEVEL_LOOKUP = '0'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

$solution = Join-Path $PSScriptRoot 'AGUI.slnx'
$command = if ($Test) { 'test' } else { 'build' }

Write-Host "dotnet $command $solution -c $Configuration $ExtraArgs"
& $dotnet $command $solution -c $Configuration @ExtraArgs
exit $LASTEXITCODE
