"""
Agent capability types for the Agent User Interaction Protocol.

Like ``types.py`` and ``events.py``, this module is a compatibility surface:
every protocol shape is re-exported from the generated models
(``ag_ui._generated.models``, emitted from ``spec/draft/schema.json`` —
regenerate with ``pnpm --filter @ag-ui/spec generate``). Nothing
protocol-shaped is declared by hand here; edit the schema, not this file.

The hand-written ``SubAgentInfo`` and ``MultiAgentCapabilities.sub_agents``
spellings are gone in 1.0 with no alias: the protocol settled on one word,
``subagent``, so the class is ``SubagentInfo`` and the field is ``subagents``
(wire key ``subagents``). Callers on the old names get an ``ImportError`` and
an ``AttributeError`` respectively rather than a silently unpopulated field.
"""

from ag_ui._generated.models import (
    SubagentInfo,
    IdentityCapabilities,
    TransportCapabilities,
    ToolsCapabilities,
    OutputCapabilities,
    StateCapabilities,
    MultiAgentCapabilities,
    ReasoningCapabilities,
    MultimodalInputCapabilities,
    MultimodalOutputCapabilities,
    MultimodalCapabilities,
    ExecutionCapabilities,
    HumanInTheLoopCapabilities,
    AgentCapabilities,
)

__all__ = [
    "SubagentInfo",
    "IdentityCapabilities",
    "TransportCapabilities",
    "ToolsCapabilities",
    "OutputCapabilities",
    "StateCapabilities",
    "MultiAgentCapabilities",
    "ReasoningCapabilities",
    "MultimodalInputCapabilities",
    "MultimodalOutputCapabilities",
    "MultimodalCapabilities",
    "ExecutionCapabilities",
    "HumanInTheLoopCapabilities",
    "AgentCapabilities",
]
