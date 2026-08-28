"""Stub out the 'swarms' package so tests run without installing it."""
import sys
from types import ModuleType
from unittest.mock import MagicMock

# Provide a minimal stub so adapter.py can import `from swarms import Agent`
# without the full swarms package being installed.
if "swarms" not in sys.modules:
    swarms_stub = ModuleType("swarms")
    swarms_stub.Agent = MagicMock  # type: ignore[attr-defined]
    sys.modules["swarms"] = swarms_stub
