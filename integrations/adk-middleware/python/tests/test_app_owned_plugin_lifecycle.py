"""Plugins supplied through an App must outlive the per-request Runner.

`_create_runner` builds one Runner per request from a shallow copy of the
caller's App, and that Runner is closed when the request finishes. Closing a
Runner also closes its plugins, so without the ownership marker every request
tore down the caller's own plugin instances and the next request paid a full
re-initialization.
"""

from types import SimpleNamespace

import pytest
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.plugins.base_plugin import BasePlugin

from ag_ui_adk import ADKAgent
from ag_ui_adk.adk_agent import _ADK_SKIPS_CLOSING_PLUGINS
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


class RecordingPlugin(BasePlugin):
    """A plugin that records whether anything closed it."""

    def __init__(self):
        super().__init__(name="recording_plugin")
        self.close_count = 0

    async def close(self) -> None:
        self.close_count += 1


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_default()
    yield
    SessionManager.reset_default()


@pytest.fixture
def plugin():
    return RecordingPlugin()


@pytest.fixture
def agent_with_plugin(plugin):
    app = App(
        name="plugin_lifecycle_app",
        root_agent=LlmAgent(name="test_agent", model=LIVE_TEST_MODEL),
        plugins=[plugin],
    )
    return ADKAgent.from_app(app, user_id="test_user", use_in_memory_services=True)


@pytest.mark.skipif(
    not _ADK_SKIPS_CLOSING_PLUGINS,
    reason="PluginManager.set_skip_closing_plugins was added in google-adk 2.2",
)
@pytest.mark.asyncio
async def test_app_owned_plugin_survives_repeated_requests(
    agent_with_plugin, plugin
):
    """The real failure mode: one shared plugin, many short-lived runners."""
    for _ in range(5):
        runner = agent_with_plugin._create_runner(
            adk_agent=agent_with_plugin._adk_agent,
            user_id="test_user",
            app_name="plugin_lifecycle_app",
        )
        await runner.close()

    assert plugin.close_count == 0


@pytest.mark.parametrize(
    "runner",
    [
        object(),
        SimpleNamespace(plugin_manager=None),
        SimpleNamespace(plugin_manager=object()),
    ],
)
def test_marking_is_a_no_op_when_adk_lacks_the_api(runner):
    """Older ADK has no set_skip_closing_plugins; marking must not raise."""
    ADKAgent._mark_plugins_externally_owned(runner)
