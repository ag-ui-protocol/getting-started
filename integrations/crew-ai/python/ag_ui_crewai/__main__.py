"""Launcher for the development-only dojo server: ``python -m ag_ui_crewai``.

Hands uvicorn the ``"ag_ui_crewai.dojo:app"`` import string and does not import the
dojo here, so the app is built once, in the reloader's worker that serves traffic.
``tests/test_launcher.py`` pins both halves of that and the ``PORT`` read below.
Why the ``-m`` target is the package, and why none of this ships: pyproject.toml.
"""

import os
import sys

import uvicorn


def _opt_out_of_crewai_telemetry() -> None:
    """Keep Ctrl-C working, by not collecting anonymous usage stats in the dojo.

    ``import crewai`` installs a SIGINT handler that chains in front of uvicorn's
    and, before delegating to it, force-flushes queued spans to crewai's OTLP
    endpoint. That is a network connect with a 30s timeout run from inside the
    handler, so the reloader's worker never reaches uvicorn's ``handle_exit``,
    and the reloader parent meanwhile blocks in ``process.join()`` still holding
    the listening socket: Ctrl-C leaves a server that only SIGKILL stops.

    This has to happen before ``uvicorn.run`` spawns the worker, since the worker
    inherits this environment and is where the app, and so crewai, is imported.
    It cannot move into ``dojo.py``: ``ag_ui_crewai/__init__.py`` imports crewai,
    so by the time any submodule body runs the handler is already installed.

    ``setdefault``, because opting a dojo run back in is a developer's call.
    """
    os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")


def main() -> int:
    """Serve the dojo, returning 0; ``tests/test_launcher.py`` pins that.

    Not every outcome comes back here: a startup failure such as a bound port exits
    non-zero from inside ``uvicorn.run``, and the reloader does not check on its
    worker, so a worker that dies at import leaves this process up with the port
    bound and requests hanging.
    """
    _opt_out_of_crewai_telemetry()
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "ag_ui_crewai.dojo:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
