"""Test-local stand-in for Strands' interrupt state.

The adapter never imports Strands' interrupt-state class. It reads the state
structurally off the agent (``activated``, ``interrupts``, ``context``), so a
test that needs a paused agent only needs an object exposing that surface.

Importing the real private class instead pins the suite to one Strands
release: it moved from ``strands.agent.interrupt.InterruptState`` to
``strands.interrupt._InterruptState``, and ``activate`` went from taking a
context (which it overwrote) to taking none. Neither difference is visible to
the adapter, so neither belongs in the tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class InterruptStateStub:
    """The interrupt-state surface the adapter observes."""

    interrupts: dict[str, Any] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    activated: bool = False

    def activate(self, context: dict[str, Any] | None = None) -> None:
        """Mark the state paused, replacing the context only when one is given."""
        if context is not None:
            self.context = context
        self.activated = True

    def deactivate(self) -> None:
        """Clear the pause, dropping interrupts and context as Strands does."""
        self.interrupts = {}
        self.context = {}
        self.activated = False

    def to_dict(self) -> dict[str, Any]:
        """Serialize the way Strands does, so checkpoint snapshots compare."""
        return {
            "interrupts": {key: itr.to_dict() for key, itr in self.interrupts.items()},
            "context": self.context,
            "activated": self.activated,
        }
