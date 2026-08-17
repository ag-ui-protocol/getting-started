"""A2UI error-recovery demo.

Same subagent path as the dynamic-schema demo: the adapter auto-injects
``generate_a2ui``, which validates each generated surface and retries on failure
(up to 3 attempts) before a tasteful hard-failure. Recovery is inherent to the
toolkit loop, so this shares the dynamic-schema turn.
"""

from crewai.flow.flow import Flow, start

from ._a2ui_subagent import run_a2ui_subagent_turn


class A2UIRecoveryFlow(Flow):
    """Dynamic A2UI with automatic validate/retry recovery."""

    @start()
    async def chat(self):
        await run_a2ui_subagent_turn(self.state)
