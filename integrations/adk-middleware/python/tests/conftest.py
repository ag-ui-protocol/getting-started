"""Shared pytest fixtures for ADK middleware tests."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

from ag_ui.core import SystemMessage as CoreSystemMessage

import ag_ui_adk.adk_agent as adk_agent_module

# ---------------------------------------------------------------------------
# LLMock server management
# ---------------------------------------------------------------------------

LLMOCK_DIR = Path(__file__).parent / "llmock"
LLMOCK_SERVER = LLMOCK_DIR / "server.mjs"
LLMOCK_FIXTURES = LLMOCK_DIR / "fixtures"


def _json_value(path: Path, *keys: str) -> str | None:
    """Read a nested string value out of a JSON file, or None if unavailable."""
    try:
        node = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node if isinstance(node, str) else None


def _ensure_llmock_deps() -> None:
    """Install LLMock's npm dependencies if missing, or if the installed version drifted.

    Gating on ``node_modules`` existence alone is version-blind: a checkout that
    installed an older aimock keeps running it forever, so local results silently
    diverge from CI, which always installs fresh. Comparing the installed version
    against the manifest catches that — but only for an exact pin. A range spec
    cannot be compared to a concrete version, so it falls back to the existence
    check rather than reinstalling on every session.

    ``npm ci`` rather than ``npm install`` so ``package-lock.json`` is
    authoritative — nothing else in the repo validates that lockfile, and
    ``npm install`` would quietly reconcile drift instead of failing.
    """
    installed_pkg = (
        LLMOCK_DIR / "node_modules" / "@copilotkit" / "aimock" / "package.json"
    )
    pinned = _json_value(
        LLMOCK_DIR / "package.json", "dependencies", "@copilotkit/aimock"
    )
    installed = _json_value(installed_pkg, "version")

    # Only an exact pin can be compared to an installed version. For a range
    # spec ("^1.37.4", ">=1.37.4", "1.x") fall back to the existence check —
    # comparing a range against a version would never match and would silently
    # reinstall on every single test session.
    exact_pin = pinned if pinned and re.fullmatch(r"\d+\.\d+\.\d+", pinned) else None
    if exact_pin is not None:
        if installed == exact_pin:
            return
    elif installed_pkg.exists():
        return

    result = subprocess.run(
        ["npm", "ci"],
        cwd=str(LLMOCK_DIR),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"npm ci for LLMock failed (exit {result.returncode}) in {LLMOCK_DIR}.\n"
            f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )

    # Verify the install actually produced what the manifest asked for. `npm ci`
    # exiting 0 is not by itself evidence the pinned version is on disk.
    if exact_pin is not None:
        now_installed = _json_value(installed_pkg, "version")
        if now_installed != exact_pin:
            raise RuntimeError(
                f"npm ci succeeded but @copilotkit/aimock is {now_installed!r}, "
                f"expected {exact_pin!r}. Is package-lock.json in sync with "
                f"package.json in {LLMOCK_DIR}?"
            )


def _start_llmock() -> tuple[subprocess.Popen, str]:
    """Start the LLMock Node.js server and return (process, base_url)."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js not available — cannot start LLMock server")

    _ensure_llmock_deps()

    proc = subprocess.Popen(
        [
            node,
            str(LLMOCK_SERVER),
            "--fixtures-dir", str(LLMOCK_FIXTURES),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(LLMOCK_DIR),
    )

    # Wait for "LLMOCK_READY <url>" on stdout
    deadline = time.monotonic() + 15
    url = None
    while time.monotonic() < deadline:
        line = proc.stdout.readline().decode().strip()
        if line.startswith("LLMOCK_READY "):
            url = line.split(" ", 1)[1]
            break
        if proc.poll() is not None:
            stderr_output = proc.stderr.read().decode()
            raise RuntimeError(f"LLMock server exited early: {stderr_output}")

    if url is None:
        proc.kill()
        raise RuntimeError("LLMock server did not become ready within 15 seconds")

    return proc, url


@pytest.fixture(scope="session")
def llmock_server():
    """Start a session-scoped LLMock server and inject env vars.

    Sets GOOGLE_GEMINI_BASE_URL and GOOGLE_API_KEY so that the google-genai
    client routes all Gemini API calls to the mock server.
    """
    # Skip if a real GOOGLE_API_KEY is already set (prefer real API)
    if os.environ.get("GOOGLE_API_KEY"):
        yield None
        return

    proc, url = _start_llmock()

    # Inject env vars that the google-genai client reads
    os.environ["GOOGLE_GEMINI_BASE_URL"] = url
    os.environ["GOOGLE_API_KEY"] = "fake-gemini-key-for-llmock"

    yield url

    # Cleanup
    os.environ.pop("GOOGLE_GEMINI_BASE_URL", None)
    os.environ.pop("GOOGLE_API_KEY", None)

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------------------
# Existing fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def restore_system_message_class():
    """Ensure every test starts and ends with the real SystemMessage type."""

    adk_agent_module.SystemMessage = CoreSystemMessage
    try:
        yield
    finally:
        adk_agent_module.SystemMessage = CoreSystemMessage
