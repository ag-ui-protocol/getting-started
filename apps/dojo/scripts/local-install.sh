#!/usr/bin/env bash
set -euo pipefail

# Links the dojo against locally-built A2UI and CopilotKit packages.
# Expects both repos to be cloned alongside ag-ui:
#   /some/path/ag-ui/
#   /some/path/A2UI/
#   /some/path/CopilotKit/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOJO_DIR="$(dirname "$SCRIPT_DIR")"
AGUI_ROOT="$(cd "$DOJO_DIR/../.." && pwd)"

# Locate sibling repos
A2UI_ROOT="$(cd "$AGUI_ROOT/../A2UI" && pwd 2>/dev/null)" || {
  echo "ERROR: A2UI repo not found at $AGUI_ROOT/../A2UI"
  echo "Clone it alongside ag-ui: git clone <a2ui-repo> $(dirname "$AGUI_ROOT")/A2UI"
  exit 1
}

COPILOTKIT_ROOT="$(cd "$AGUI_ROOT/../CopilotKit" && pwd 2>/dev/null)" || {
  echo "ERROR: CopilotKit repo not found at $AGUI_ROOT/../CopilotKit"
  echo "Clone it alongside ag-ui: git clone <copilotkit-repo> $(dirname "$AGUI_ROOT")/CopilotKit"
  exit 1
}

echo "ag-ui root:       $AGUI_ROOT"
echo "A2UI root:        $A2UI_ROOT"
echo "CopilotKit root:  $COPILOTKIT_ROOT"
echo ""

# 1. Build A2UI renderer packages (web_core must be built before react)
echo "=== Building A2UI renderer packages ==="
cd "$A2UI_ROOT/renderers/web_core" && npm run build
cd "$A2UI_ROOT/renderers/react" && npm run build

# 2. Link A2UI into CopilotKit and build TypeScript packages
echo ""
echo "=== Linking A2UI into CopilotKit and building ==="
cd "$COPILOTKIT_ROOT"
A2UI_LOCAL=1 pnpm install
./node_modules/.bin/nx run-many -t build -p \
  @copilotkit/react-core \
  @copilotkit/react-ui \
  @copilotkit/runtime \
  @copilotkit/runtime-client-gql \
  @copilotkit/shared \
  @copilotkit/a2ui-renderer

# 3. Link everything into ag-ui workspace via .pnpmfile.cjs
#    (must happen before middleware build so workspace deps are available)
echo ""
echo "=== Linking local packages into ag-ui workspace ==="
cd "$AGUI_ROOT"
COPILOTKIT_LOCAL=1 A2UI_LOCAL=1 pnpm install

# 4. Build all ag-ui workspace packages (excluding the dojo app itself)
echo ""
echo "=== Building ag-ui workspace packages ==="
cd "$AGUI_ROOT"
pnpm --filter @ag-ui/proto generate
pnpm -r --filter='!demo-viewer' --filter='!client-cli-example' build

# 5. Copy middleware dist to CopilotKit's pnpm store
#    (CopilotKit has its own npm copy of @ag-ui/a2ui-middleware;
#    the workspace link doesn't reach it, so we copy the built files)
echo ""
echo "=== Syncing a2ui-middleware into CopilotKit pnpm store ==="
MIDDLEWARE_SOURCE="$AGUI_ROOT/middlewares/a2ui-middleware/dist"
MIDDLEWARE_TARGET=$(find "$COPILOTKIT_ROOT/node_modules/.pnpm" \
  -path "*/@ag-ui/a2ui-middleware/dist" -type d 2>/dev/null | head -1)

if [ -n "$MIDDLEWARE_TARGET" ]; then
  for f in index.mjs index.js index.mjs.map index.js.map index.d.mts index.d.ts; do
    if [ -f "$MIDDLEWARE_SOURCE/$f" ]; then
      rm -f "$MIDDLEWARE_TARGET/$f"
      cat "$MIDDLEWARE_SOURCE/$f" > "$MIDDLEWARE_TARGET/$f"
    fi
  done
  echo "  Copied middleware dist to $MIDDLEWARE_TARGET"
else
  echo "  WARNING: Could not find a2ui-middleware in CopilotKit pnpm store."
  echo "  The middleware changes may not take effect in the CopilotKit runtime."
fi

# 5b. Sync the LOCAL @ag-ui/a2ui-toolkit next to the synced middleware (OSS-162).
#     The recovery middleware imports @ag-ui/a2ui-toolkit, but CopilotKit's tree has
#     no copy of it, so the synced middleware above would fail to resolve it
#     ("Module not found: Can't resolve '@ag-ui/a2ui-toolkit'"). The toolkit has zero
#     runtime deps, so dropping its package.json + dist into the middleware's pnpm
#     peer-dir (the @ag-ui namespace dir) is enough for resolution.
echo ""
echo "=== Syncing a2ui-toolkit into CopilotKit pnpm store (OSS-162) ==="
TOOLKIT_SOURCE="$AGUI_ROOT/sdks/typescript/packages/a2ui-toolkit"
if [ -n "$MIDDLEWARE_TARGET" ] && [ -d "$TOOLKIT_SOURCE/dist" ]; then
  # MIDDLEWARE_TARGET = .../node_modules/@ag-ui/a2ui-middleware/dist
  AGUI_NS="$(dirname "$(dirname "$MIDDLEWARE_TARGET")")" # -> .../node_modules/@ag-ui
  TOOLKIT_TARGET="$AGUI_NS/a2ui-toolkit"
  rm -rf "$TOOLKIT_TARGET"
  mkdir -p "$TOOLKIT_TARGET"
  cp "$TOOLKIT_SOURCE/package.json" "$TOOLKIT_TARGET/"
  cp -R "$TOOLKIT_SOURCE/dist" "$TOOLKIT_TARGET/dist"
  echo "  Placed a2ui-toolkit at $TOOLKIT_TARGET"
else
  echo "  WARNING: could not place a2ui-toolkit (missing middleware target or toolkit dist)."
  echo "  Build it first: pnpm --filter @ag-ui/a2ui-toolkit build"
fi

# 6. Install local CopilotKit Python SDK for langgraph agent
LANGGRAPH_EXAMPLES="$AGUI_ROOT/integrations/langgraph/python/examples"
if [ -d "$LANGGRAPH_EXAMPLES" ] && [ -d "$COPILOTKIT_ROOT/sdk-python" ]; then
  echo ""
  echo "=== Installing local CopilotKit Python SDK for langgraph agent ==="
  cd "$LANGGRAPH_EXAMPLES"
  if [ ! -d ".venv" ] && command -v uv &>/dev/null; then
    echo "  Creating Python venv and installing dependencies..."
    uv venv && uv sync
  fi
  if [ -d ".venv" ]; then
    uv pip install -e "$COPILOTKIT_ROOT/sdk-python"
  else
    echo "  WARNING: No .venv found. Skipping Python SDK install."
    echo "  Create it manually: cd $LANGGRAPH_EXAMPLES && uv venv && uv sync"
  fi
fi

echo ""
echo "=== Done! All local packages linked ==="
echo ""
echo "To start the dojo:"
echo "  1. Start the Python agent:"
echo "     cd $LANGGRAPH_EXAMPLES && source .venv/bin/activate && uvicorn agents.dojo:app --port 8000"
echo "  2. Start the dojo frontend:"
echo "     cd $DOJO_DIR && npm run dev"
echo ""
echo "To revert to npm versions: pnpm install (without env vars)"
