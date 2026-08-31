"""CopilotKitState must keep the context entries the endpoint writes.

``crewai_prepare_inputs`` serializes ``RunAgentInput.context`` onto the
kickoff dict under ``context``. A Flow state is a Pydantic model, so a
missing field meant those entries were discarded with no error, and
``self.state.context`` never existed for Flow authors.
"""

from ag_ui.core import Context
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai.sdk import CopilotKitState
from pydantic import Field


def test_copilotkit_state_defaults_context_to_empty_list():
    assert CopilotKitState().context == []


def test_copilotkit_state_keeps_constructor_context():
    class MyState(CopilotKitState):
        pass

    entries = [{"description": "queue", "value": "THE QUEUE"}]
    state = MyState(**{"messages": [], "context": entries})
    assert state.context == entries


def test_prepared_inputs_survive_copilotkit_state_validation():
    prepared = ep.crewai_prepare_inputs(
        state={},
        messages=[],
        tools=[],
        context=[Context(description="queue", value="THE QUEUE")],
    )
    state = CopilotKitState(**prepared)
    assert state.context == [{"description": "queue", "value": "THE QUEUE"}]


def test_context_is_included_in_state_snapshots():
    entries = [{"description": "queue", "value": "THE QUEUE"}]
    dumped = CopilotKitState(context=entries).model_dump()
    assert dumped["context"] == entries
    assert "current_user_message" not in dumped


def test_subclass_that_already_declares_context_keeps_its_value():
    class AlreadyHasContext(CopilotKitState):
        context: list = Field(default_factory=list)

    entries = [{"description": "page", "value": "title"}]
    state = AlreadyHasContext(context=entries)
    assert state.context == entries
