"""Hook-dispatch helpers shared by Strands test doubles."""

from typing import Any

from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent
from strands.hooks.registry import HookRegistry


def invoke_before_model_call(registry: HookRegistry, agent: Any) -> None:
    """Dispatch through the synchronous API supported since Strands 1.15."""
    registry.invoke_callbacks(BeforeModelCallEvent(agent=agent))


def invoke_after_model_call(registry: HookRegistry, agent: Any) -> None:
    """Dispatch through the synchronous API supported since Strands 1.15."""
    registry.invoke_callbacks(AfterModelCallEvent(agent=agent))
