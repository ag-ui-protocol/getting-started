@echo off
REM Provisions a repo-local .NET SDK (if needed) and builds the AG-UI .NET SDK.
REM Thin wrapper around build.ps1. All arguments are forwarded.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %ERRORLEVEL%
