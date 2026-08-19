# Dojo server for Claude Managed Agents (.NET).
#
# Build from the repository root so the project can resolve the ag-ui .NET SDK
# it references through $(AGUIDotnetSdkDir):
#
#   docker build \
#     -f integrations/claude-managed-agents/dotnet/examples/AGUIDojoServer/Dockerfile \
#     -t agui-cma-dojo .
#
# Run with the API key in the environment; the container listens on $PORT (default 10000):
#
#   docker run --rm -e ANTHROPIC_API_KEY=sk-ant-... -e PORT=8026 -p 8026:8026 agui-cma-dojo
#
# The context is the whole repository, so Dockerfile.dockerignore beside this
# file keeps a developer's .env, host bin/obj, node_modules and .git out of it.
# Requires BuildKit (the default builder), which is what reads that file.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS builder
WORKDIR /repo

# Keep the repo-relative layout: the integration's Directory.Build.props points
# at ../../../sdks/dotnet from integrations/claude-managed-agents/dotnet.
COPY sdks/dotnet ./sdks/dotnet
COPY integrations/claude-managed-agents/dotnet ./integrations/claude-managed-agents/dotnet

# Belt and braces for a context that slipped through (a legacy builder ignores
# Dockerfile.dockerignore): restore and publish from a clean tree, and never
# carry a copied secret into a layer.
RUN find . -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + \
 && find . -name '.env' -type f -delete

WORKDIR /repo/integrations/claude-managed-agents/dotnet
RUN dotnet publish examples/AGUIDojoServer/AGUIDojoServer.csproj -c Release -o /app/out

# Runtime image
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app

# Run as the image's built-in non-root user; it owns /app so setup can write
# .managed-agents.json next to the assembly.
RUN chown -R app /app
USER app

COPY --from=builder --chown=app /app/out .

# Honor the platform-provided PORT (Render sets it; default to 10000).
ENV PORT=10000
EXPOSE 10000

# Provision the environment and agents idempotently, then serve. A failed
# setup must not stop the server from starting.
ENTRYPOINT ["/bin/sh", "-c", "dotnet AGUIDojoServer.dll setup || echo 'setup failed; serving whatever is provisioned'; export ASPNETCORE_URLS=http://+:${PORT:-10000}; exec dotnet AGUIDojoServer.dll"]
