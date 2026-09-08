"""Import-hygiene guard for the A2UI hybrid (OSS-158).

The adapter reuses Google's ``a2ui-agent-sdk`` but ONLY its A2A-free subset
(``a2ui.schema`` / ``a2ui.parser`` / ``a2ui.basic_catalog``). Importing
``ag_ui_adk`` must never pull in ``a2a`` or the A2A/ADK-coupled ``a2ui`` modules
(``a2ui.a2a`` / ``a2ui.adk``) — those would (a) reintroduce the ``a2a-sdk`` import
coupling the proof-point had to pin around, and (b) make the runtime drag A2A
machinery it never uses. This runs in a subprocess so it observes a clean import
graph, not whatever the test session already loaded.
"""

import subprocess
import sys


def test_importing_ag_ui_adk_never_imports_a2a():
    code = (
        "import sys, ag_ui_adk, ag_ui_adk.a2ui_tool, ag_ui_adk.a2ui_google_sdk\n"
        "bad = sorted(m for m in sys.modules\n"
        "             if m == 'a2a' or m.startswith('a2a.')\n"
        "             or m == 'a2ui.a2a' or m.startswith('a2ui.a2a.')\n"
        "             or m == 'a2ui.adk' or m.startswith('a2ui.adk.'))\n"
        "assert not bad, f'ag_ui_adk pulled A2A/ADK-coupled modules: {bad}'\n"
        "print('clean')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True
    )
    assert result.returncode == 0, (
        f"import-hygiene check failed:\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "clean" in result.stdout
