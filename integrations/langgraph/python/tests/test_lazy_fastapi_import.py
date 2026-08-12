"""Regression for #2013 — package import must not require fastapi.

`fastapi` is an optional extra, but `__init__.py` used to eagerly import
`endpoint.py`, which imports fastapi at module top. Middleware-only installs
then failed on any `import ag_ui_langgraph`.
"""

from __future__ import annotations

import importlib
import sys
import unittest


class TestLazyFastapiImport(unittest.TestCase):
    def test_init_does_not_import_endpoint_module(self):
        # Drop package modules so we re-import against current source.
        for name in list(sys.modules):
            if name == "ag_ui_langgraph" or name.startswith("ag_ui_langgraph."):
                del sys.modules[name]

        import ag_ui_langgraph  # noqa: F401

        self.assertNotIn("ag_ui_langgraph.endpoint", sys.modules)

        # Core exports still resolve without touching the FastAPI path.
        from ag_ui_langgraph import LangGraphAgent  # noqa: F401

        self.assertNotIn("ag_ui_langgraph.endpoint", sys.modules)

    def test_endpoint_export_is_available_lazily(self):
        for name in list(sys.modules):
            if name == "ag_ui_langgraph" or name.startswith("ag_ui_langgraph."):
                del sys.modules[name]

        import ag_ui_langgraph

        endpoint_fn = ag_ui_langgraph.add_langgraph_fastapi_endpoint
        self.assertTrue(callable(endpoint_fn))
        self.assertIn("ag_ui_langgraph.endpoint", sys.modules)


if __name__ == "__main__":
    unittest.main()
