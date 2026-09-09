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
(wire key ``subagents``).

Only half of that rename is protected by an exception. ``SubAgentInfo`` is not
exported, so importing it raises ``ImportError``. ``sub_agents`` is NOT: the
generated base sets ``extra="allow"``, so
``MultiAgentCapabilities(sub_agents=[...])`` constructs without complaint,
keeps the value as an extra field, reads it back under the old name, and
serializes the old wire key ``sub_agents`` — while ``subagents`` stays
``None``. There is no error and no warning anywhere on that path. Callers
still on the field name have to be found by searching for it, not by running
the code and waiting for it to fail.
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
