#!/usr/bin/env pwsh
#Requires -Version 7

<#
.SYNOPSIS
    Runs the full AG-UI .NET SDK test suite with one command.

.DESCRIPTION
    Runs, in order:
      1. Unit tests        — AGUI.{Abstractions,Client,Formatting,Protobuf,Server}.UnitTests
      2. Integration tests — AGUI.Hosting.AspNetCore.IntegrationTests (SSE + protobuf transports)
      3. Cross-language    — Phase 1 (TS HttpAgent -> C# server, Vitest) and
                             Phase 2 (C# AGUIChatClient -> TS fake server, xUnit)

    The cross-language phases need Node + pnpm; pass -NoCrossLanguage to skip them
    (for a pure .NET run) or -NoInstall to skip the 'pnpm install' step.

.PARAMETER Configuration
    Build configuration: Release (default) or Debug.

.PARAMETER NoCrossLanguage
    Skip the cross-language suites (no Node/pnpm needed).

.PARAMETER NoInstall
    Skip 'pnpm install' (assume the workspace is already installed).

.EXAMPLE
    ./test.ps1
.EXAMPLE
    ./test.ps1 -Configuration Debug -NoCrossLanguage
#>
[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",
    [switch]$NoCrossLanguage,
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
$dotnetDir = Join-Path $repoRoot "sdks/dotnet"

# One unit-test project per src/ package.
$unitProjects = @(
    "tests/AGUI.Abstractions.UnitTests"
    "tests/AGUI.Client.UnitTests"
    "tests/AGUI.Formatting.UnitTests"
    "tests/AGUI.Protobuf.UnitTests"
    "tests/AGUI.Server.UnitTests"
)

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "FAILED: $Name (exit $LASTEXITCODE)" }
}

Push-Location $dotnetDir
try {
    foreach ($project in $unitProjects) {
        Invoke-Step "unit: $project" { dotnet test $project -c $Configuration }
    }

    Invoke-Step "integration: tests/AGUI.Hosting.AspNetCore.IntegrationTests" {
        dotnet test "tests/AGUI.Hosting.AspNetCore.IntegrationTests" -c $Configuration
    }

    if (-not $NoCrossLanguage) {
        if (-not $NoInstall) {
            Invoke-Step "pnpm install (cross-language workspace deps)" {
                Push-Location $repoRoot
                try { pnpm install --frozen-lockfile } finally { Pop-Location }
            }
        }

        Invoke-Step "cross-language phase 1 (TS client -> C# server) [vitest]" {
            Push-Location $repoRoot
            try { pnpm --filter '@ag-ui/cross-language-tests' test } finally { Pop-Location }
        }

        Invoke-Step "cross-language phase 2 (C# client -> TS server)" {
            dotnet test "tests/AGUI.CrossLanguage.IntegrationTests" -c $Configuration
        }
    }

    Write-Host "All AG-UI .NET SDK tests passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
