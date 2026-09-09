"""ag_ui_langgraph must import without FastAPI installed (gh #2067).

FastAPI is an optional dependency (only the HTTP endpoint helper in endpoint.py
uses it), but __init__.py eagerly imported .endpoint, so `import ag_ui_langgraph`
/ `from ag_ui_langgraph import LangGraphAgent` raised ModuleNotFoundError when
FastAPI wasn't installed — breaking every purely in-process consumer that just
iterates LangGraphAgent.run() to render AG-UI events locally.
"""
import subprocess
import sys
import textwrap
import unittest


# Runs in a fresh subprocess so blocking `fastapi` doesn't disturb the rest of the
# suite (which installs FastAPI for the endpoint tests).
_SCRIPT = textwrap.dedent(
    """
    import importlib.abc
    import sys

    class _Blocker(importlib.abc.MetaPathFinder):
        _blocked = ("fastapi", "starlette")

        def find_spec(self, name, path=None, target=None):
            top = name.split(".", 1)[0]
            if top in self._blocked:
                raise ImportError(f"blocked '{name}' to simulate FastAPI being absent")
            return None

    sys.meta_path.insert(0, _Blocker())
    for mod in list(sys.modules):
        top = mod.split(".", 1)[0]
        if top in ("fastapi", "starlette", "ag_ui_langgraph"):
            del sys.modules[mod]

    # Sanity: FastAPI really is unreachable in this subprocess.
    try:
        import fastapi  # noqa: F401
    except ImportError:
        pass
    else:
        raise SystemExit("test setup bug: fastapi was still importable")

    import ag_ui_langgraph
    from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

    assert LangGraphAgent is not None, "LangGraphAgent must import without FastAPI"
    assert add_langgraph_fastapi_endpoint is None, (
        "add_langgraph_fastapi_endpoint should be None when FastAPI is absent"
    )
    print("OK")
    """
)


class TestImportWithoutFastAPI(unittest.TestCase):
    def test_package_imports_when_fastapi_is_absent(self):
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT],
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"importing ag_ui_langgraph without FastAPI failed:\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}",
        )
        self.assertIn("OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
