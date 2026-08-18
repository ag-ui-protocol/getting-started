"""Dojo demo flows for the AG-UI CrewAI integration.

The telemetry opt-out below runs on import of this package, which is the only point
early enough to work. ``import crewai`` installs a SIGINT handler that force-flushes
queued spans to crewai's OTLP endpoint before delegating to uvicorn's, a network
connect with a 30s timeout run from inside the handler. With it installed, Ctrl-C
leaves a dojo server that only SIGKILL stops.

``ag_ui_crewai/__init__.py`` imports crewai, so anything that imports the bridge is
already too late; ``dojo.py`` imports the bridge at module scope, so its own body is
too late as well. Importing ``agents.dojo`` runs this file first, before either.

``setdefault``, because opting a dojo run back in is a developer's call.
"""

import os

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
