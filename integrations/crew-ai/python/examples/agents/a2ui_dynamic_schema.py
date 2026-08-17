"""A2UI dynamic-schema demo.

A plain agentic-chat flow with no A2UI tool wired: the frontend a2ui middleware
forwards ``injectA2UITool`` and the adapter auto-injects ``generate_a2ui``,
which designs a surface from the conversation against the dojo's dynamic catalog
(pillars 1-4). See ``_a2ui_subagent`` for the shared turn.
"""

from crewai.flow.flow import Flow, start

from ._a2ui_subagent import run_a2ui_subagent_turn


class A2UIDynamicSchemaFlow(Flow):
    """Dynamic A2UI surfaces generated on the fly via the auto-injected tool."""

    @start()
    async def chat(self):
        await run_a2ui_subagent_turn(self.state)
