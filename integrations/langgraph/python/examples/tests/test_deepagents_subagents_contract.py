import os
import subprocess
import sys
from pathlib import Path


def test_deepagents_subagents_graph_imports_without_openai_key():
    env = os.environ.copy()
    env.pop("OPENAI_API_KEY", None)
    result = subprocess.run(
        [sys.executable, "-c", "from agents.deepagents_subagents.agent import graph; assert graph"],
        cwd=Path(__file__).parents[1],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
