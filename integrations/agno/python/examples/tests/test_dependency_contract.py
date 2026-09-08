from __future__ import annotations

import tomllib
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = PROJECT_ROOT / "pyproject.toml"
LOCKFILE = PROJECT_ROOT / "uv.lock"
README = PROJECT_ROOT / "README.md"
RENDER_CONFIG = PROJECT_ROOT.parents[3] / "render.yaml"


def _project_dependencies() -> set[str]:
    project = tomllib.loads(PYPROJECT.read_text())
    return {dependency.replace(" ", "") for dependency in project["project"]["dependencies"]}


def _locked_version(package_name: str) -> str:
    lock = tomllib.loads(LOCKFILE.read_text())
    matches = [
        package["version"]
        for package in lock["package"]
        if package["name"] == package_name
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"expected one locked {package_name} package, found {matches!r}"
        )
    return matches[0]


class DependencyContractTests(unittest.TestCase):
    def test_declares_supported_runtime_ranges_and_required_extras(self) -> None:
        dependencies = _project_dependencies()

        self.assertIn("agno[agui,google,os]>=3.0.4,<4", dependencies)
        self.assertIn("ag-ui-protocol>=0.1.22,<0.2", dependencies)
        self.assertIn("python-dotenv>=1.0,<2", dependencies)
        self.assertIn("packaging>=24,<27", dependencies)
        self.assertFalse(any(dependency.startswith("dotenv") for dependency in dependencies))

    def test_lock_uses_latest_verified_compatible_artifacts(self) -> None:
        self.assertEqual(_locked_version("agno"), "3.0.5")
        self.assertEqual(_locked_version("ag-ui-protocol"), "0.1.22")

    def test_pyproject_is_the_only_dependency_source(self) -> None:
        self.assertFalse(
            (PROJECT_ROOT / "requirements.txt").exists(),
            "requirements.txt duplicates and can drift from pyproject.toml",
        )

    def test_setup_docs_and_render_install_from_the_committed_lock(self) -> None:
        readme = README.read_text()
        render_config = RENDER_CONFIG.read_text()
        agno_service = render_config.split("name: ag-ui-dojo-agno", 1)[1].split(
            "    - type:", 1
        )[0]

        self.assertIn("uv sync --frozen", readme)
        self.assertIn("uv run --frozen dev", readme)
        self.assertIn(
            "uv run --frozen python -m unittest discover -s tests", readme
        )
        self.assertIn("(MIGRATING_TO_AGNO_3.md)", readme)
        self.assertIn("Python 3.12 through 3.x", readme)
        self.assertNotIn("agent.py", readme)
        self.assertIn("buildCommand: uv sync --frozen", agno_service)
        self.assertIn("startCommand: uv run --frozen dev", agno_service)
        self.assertIn("maxInstances: 1", agno_service)
        self.assertIn("- key: GOOGLE_API_KEY", agno_service)


if __name__ == "__main__":
    unittest.main()
