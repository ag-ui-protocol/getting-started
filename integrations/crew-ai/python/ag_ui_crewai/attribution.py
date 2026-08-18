"""Hierarchical boundary attribution for the CrewAI -> AG-UI bridge.

Background
----------
CrewAI has no wire-level namespace analogous to LangGraph's
``langgraph_checkpoint_ns``. The bridge previously emitted one flat
``STEP_STARTED`` / ``STEP_FINISHED`` pair per Flow ``MethodExecution*``
event: no nesting, no attribution of a Crew running inside a Flow method,
no Agent identity.

This module reconstructs the run topology (Flow method -> nested Crew ->
Agent) from the identity CrewAI carries on its own lifecycle events
(``method_name`` / ``crew_name`` / agent ``role``) plus a boundary
*stack*. The reconstructed hierarchy rides on every STEP event through the
protocol's free-form ``raw_event`` field (serialised ``rawEvent``):

* ``step_name`` is unchanged (the method / crew / agent identity), so
  consumers that key on it are unaffected; flow-method steps additionally
  gain a populated ``raw_event`` where the old bridge left it ``None`` (an
  additive change).
* topology-aware clients read ``raw_event["attribution"]`` for ``depth``,
  ``parent_step_id``, the root-to-leaf ``path`` (the authoritative
  representation; ``qualified_name`` is a convenience join), and a unique
  ``step_id`` shared by a boundary's start and finish events (so two
  boundaries with the same ``step_name`` are still distinguishable). This
  is the surface a client needs to render Flow-orchestrated Crews as a
  tree. CrewAI has no compiled-subgraph primitive, so this is Flow
  composition, not a LangGraph subgraph analogue.

Threading contract
------------------
:class:`BoundaryTracker` is a plain single stack with NO internal locking.
It is only ever driven from CrewAI's **ordered StreamFrame path**
(``StreamFrameTranslator``), where frames are translated one at a time on
the request's event-loop thread in emit order. That single-threaded,
in-order contract is what makes a stack correct: ``enter`` on a start
frame, ``exit`` on the matching finish frame, ``drain_all`` at run end.

It is deliberately NOT driven from the legacy crewai event-bus listener
path: crewai 1.x dispatches those sync handlers on a fire-and-forget
ThreadPoolExecutor (``max_workers=10``), so handler execution is neither
ordered nor single-threaded and a live stack there would race and
mis-nest. The legacy path therefore emits only flat, per-method
attribution (flow ownership + a step id), which needs no ordering.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ag_ui.core import EventType
from ag_ui.core.events import StepStartedEvent, StepFinishedEvent

# Boundary kinds. Plain strings (not an enum) because they are serialised
# verbatim under ``attribution.boundary`` and are part of the consumer
# contract.
FLOW_METHOD = "flow_method"
CREW = "crew"
AGENT = "agent"

#: Identifies the producing adapter so a multi-framework client can branch.
ATTRIBUTION_ADAPTER = "crewai"

#: Separator joining the root-to-leaf path into ``qualified_name``.
PATH_SEPARATOR = "/"

#: Pairing key ``(boundary_type, name)``. Names are stable across a
#: boundary's start and finish events (``method_name`` / ``crew_name`` /
#: agent role), so they pair without depending on CrewAI populating
#: ``source_fingerprint`` identically on both. Repeated names are
#: disambiguated by the unique ``step_id`` in the payload; within one
#: ordered run the LIFO stack pairs the nearest match correctly.
BoundaryKey = Tuple[str, str]


def boundary_key(boundary_type: str, name: str) -> BoundaryKey:
    """Return the start/finish pairing key for a boundary."""
    return (boundary_type, name)


@dataclass
class Boundary:
    """One node in the reconstructed execution hierarchy.

    Created when a Flow method / Crew / Agent starts and resolved again
    when it finishes, so its ``STEP_STARTED`` and ``STEP_FINISHED`` events
    share the same ``step_id`` and parent linkage.
    """

    boundary_type: str
    name: str
    key: BoundaryKey
    step_id: str
    parent_id: Optional[str]
    depth: int
    fingerprint: Optional[str] = None
    flow_name: Optional[str] = None
    path: Tuple[str, ...] = field(default_factory=tuple)

    def attribution(self) -> Dict[str, Any]:
        """Serialise into the ``raw_event.attribution`` payload."""
        return {
            "adapter": ATTRIBUTION_ADAPTER,
            "boundary": self.boundary_type,
            "depth": self.depth,
            "step_id": self.step_id,
            "parent_step_id": self.parent_id,
            "path": list(self.path),
            "qualified_name": PATH_SEPARATOR.join(self.path),
            "flow_name": self.flow_name,
            "fingerprint": self.fingerprint,
        }


class BoundaryTracker:
    """Single ordered stack of open :class:`Boundary` objects for one run.

    See the module "Threading contract": one tracker per run, driven
    single-threaded and in emit order by the StreamFrame translator.
    """

    def __init__(self) -> None:
        self._stack: List[Boundary] = []

    @property
    def stack(self) -> Tuple[Boundary, ...]:
        return tuple(self._stack)

    def current(self) -> Optional[Boundary]:
        return self._stack[-1] if self._stack else None

    def enter(
        self,
        boundary_type: str,
        name: str,
        *,
        fingerprint: Optional[str] = None,
        flow_name: Optional[str] = None,
    ) -> Boundary:
        """Push a boundary and return it.

        Flow methods are roots (depth 0, no parent): a Flow's methods are
        its top level and never nest under one another, so concurrent
        ``@listen`` methods stay independent siblings rather than being
        chained under whichever one opened first. Crews and Agents nest
        under the current top-of-stack (their enclosing method / crew) and
        inherit its ``flow_name``. ``fingerprint`` rides on the payload but
        is not part of the pairing key.
        """
        parent = None if boundary_type == FLOW_METHOD else self.current()
        effective_flow = flow_name if flow_name is not None else (
            parent.flow_name if parent is not None else None
        )
        boundary = Boundary(
            boundary_type=boundary_type,
            name=name,
            key=boundary_key(boundary_type, name),
            step_id=uuid.uuid4().hex,
            parent_id=parent.step_id if parent is not None else None,
            depth=(parent.depth + 1) if parent is not None else 0,
            fingerprint=fingerprint,
            flow_name=effective_flow,
            path=((parent.path if parent is not None else ()) + (name,)),
        )
        self._stack.append(boundary)
        return boundary

    def exit(self, boundary_type: str, name: str) -> List[Boundary]:
        """Close the nearest matching boundary; return boundaries to finish.

        Returns the matched boundary plus the still-open boundaries nested
        above it, **deepest-first**, so the caller emits balanced
        ``STEP_FINISHED`` events (inner boundaries close before their
        enclosing one). Those dangling inners are boundaries whose own
        finish frame never arrived (e.g. a sub-crew that raised); closing
        them keeps every ``STEP_STARTED`` matched. Empty list => no open
        match, so the caller emits nothing rather than an unbalanced close.

        A boundary closes only its own subtree: the still-open boundaries
        above it are followed up to (not through) the next open Flow method,
        so a concurrent sibling ``@listen`` method (and its steps) sitting
        above it on the stack is left untouched. Flow methods are the only
        boundary kind that opens a new subtree, so stopping at one is what
        keeps parallel branches independent.
        """
        key = boundary_key(boundary_type, name)
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index].key == key:
                end = index + 1
                while (
                    end < len(self._stack)
                    and self._stack[end].boundary_type != FLOW_METHOD
                ):
                    end += 1
                closed = self._stack[index:end]
                del self._stack[index:end]
                closed.reverse()  # deepest (innermost) first
                return closed
        return []

    def drain_all(self) -> List[Boundary]:
        """Close and return every still-open boundary (deepest-first).

        Called on normal run end (flow_finished / clean stream exhaustion) so a
        boundary whose finish frame was lost is still closed on the wire. Leaves
        the tracker empty. Abnormal termination (RUN_ERROR) does NOT drain: the
        error path emits RUN_ERROR and open boundaries are left unclosed.
        """
        drained = list(reversed(self._stack))
        self._stack.clear()
        return drained


def _raw_event(boundary: Boundary, source_event_type: Optional[str]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"attribution": boundary.attribution()}
    if source_event_type:
        # Originating CrewAI event type for provenance / debugging.
        payload["crewai_event_type"] = source_event_type
    return payload


def step_started_event(
    boundary: Boundary, *, source_event_type: Optional[str] = None
) -> StepStartedEvent:
    """Build a ``STEP_STARTED`` carrying ``boundary``'s attribution."""
    return StepStartedEvent(
        type=EventType.STEP_STARTED,
        step_name=boundary.name,
        raw_event=_raw_event(boundary, source_event_type),
    )


def step_finished_event(
    boundary: Boundary, *, source_event_type: Optional[str] = None
) -> StepFinishedEvent:
    """Build a ``STEP_FINISHED`` carrying ``boundary``'s attribution."""
    return StepFinishedEvent(
        type=EventType.STEP_FINISHED,
        step_name=boundary.name,
        raw_event=_raw_event(boundary, source_event_type),
    )


def flat_method_attribution(
    method_name: str,
    *,
    flow_name: Optional[str],
    fingerprint: Optional[str],
    step_id: str,
) -> Dict[str, Any]:
    """Attribution payload for a flat (depth-0) Flow-method boundary.

    Used by the legacy event-bus path, which cannot maintain an ordered
    stack (see the module "Threading contract"). It conveys flow ownership
    and a stable per-run ``step_id`` for the method without claiming any
    nesting: ``depth`` 0, ``parent_step_id`` None, single-element ``path``.
    The ``step_id`` must be the SAME on the method's start and finish so a
    consumer can pair them; the caller is responsible for that.
    """
    return {
        "attribution": {
            "adapter": ATTRIBUTION_ADAPTER,
            "boundary": FLOW_METHOD,
            "depth": 0,
            "step_id": step_id,
            "parent_step_id": None,
            "path": [method_name],
            "qualified_name": method_name,
            "flow_name": flow_name,
            "fingerprint": fingerprint,
        }
    }
