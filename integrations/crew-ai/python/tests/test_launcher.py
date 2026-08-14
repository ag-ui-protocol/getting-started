"""Runtime contract of the ``python -m ag_ui_crewai`` dojo launcher.

``render.yaml`` and ``apps/dojo/scripts/run-dojo-everything.js`` both invoke that
command and both set ``PORT``, and the uvicorn target has to stay an import string
for the app to be built once. Neither survives a well-meaning simplification
unless something asserts it, so this file asserts it.
"""

import os
import subprocess
import sys

import pytest

from ag_ui_crewai import __main__ as launcher


@pytest.fixture
def uvicorn_calls(monkeypatch):
    """Record the launcher's ``uvicorn.run`` calls instead of serving anything."""
    calls = []
    monkeypatch.setattr(
        launcher.uvicorn,
        "run",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    return calls


def _target(call):
    """The app the launcher handed uvicorn, positional or keyword."""
    args, kwargs = call
    return args[0] if args else kwargs["app"]


def test_uvicorn_gets_an_import_string_not_an_app_object(uvicorn_calls):
    launcher.main()

    target = _target(uvicorn_calls[0])
    assert isinstance(target, str), (
        "the target must stay an import string: an app object here is built in "
        f"this process and again in the reloader's worker, got {target!r}"
    )
    assert target == "ag_ui_crewai.dojo:app"


def test_importing_the_launcher_does_not_import_the_dojo():
    """The other half of the single build: the string names the dojo, so this
    process must not import it as well."""
    probe = (
        "import sys, ag_ui_crewai.__main__;"
        " print('ag_ui_crewai.dojo' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout.strip() == "False", result.stderr


def test_port_falls_back_to_8000(uvicorn_calls, monkeypatch):
    monkeypatch.delenv("PORT", raising=False)

    launcher.main()

    assert uvicorn_calls[0][1]["port"] == 8000


def test_port_comes_from_the_environment(uvicorn_calls, monkeypatch):
    monkeypatch.setenv("PORT", "8003")

    launcher.main()

    assert uvicorn_calls[0][1]["port"] == 8003


def test_a_non_numeric_port_fails_loudly(uvicorn_calls, monkeypatch):
    monkeypatch.setenv("PORT", "eight-thousand")

    with pytest.raises(ValueError):
        launcher.main()

    assert uvicorn_calls == []


def test_main_returns_zero(uvicorn_calls):
    assert launcher.main() == 0


def test_telemetry_is_opted_out_before_the_worker_is_spawned(uvicorn_calls, monkeypatch):
    """Ctrl-C has to work.

    crewai's telemetry chains a SIGINT handler that force-flushes spans over the
    network, which wedges the reloader's worker mid-shutdown. The opt-out has to
    be in the environment before ``uvicorn.run`` spawns that worker, because the
    worker inherits this environment and imports crewai there.
    """
    monkeypatch.delenv("CREWAI_DISABLE_TELEMETRY", raising=False)
    seen = []
    monkeypatch.setattr(
        launcher.uvicorn,
        "run",
        lambda *a, **k: seen.append(os.environ.get("CREWAI_DISABLE_TELEMETRY")),
    )

    launcher.main()

    assert seen == ["true"]


def test_an_explicit_telemetry_choice_is_left_alone(uvicorn_calls, monkeypatch):
    """Opting back in is a developer's call to make, so don't overwrite it."""
    monkeypatch.setenv("CREWAI_DISABLE_TELEMETRY", "false")

    launcher.main()

    assert os.environ["CREWAI_DISABLE_TELEMETRY"] == "false"
