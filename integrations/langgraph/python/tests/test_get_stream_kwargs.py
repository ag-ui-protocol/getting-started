import unittest

from ag_ui_langgraph.agent import LangGraphAgent


class _GraphWithNamedContext:
    nodes = {}

    def astream_events(self, input, subgraphs=False, version="v2", context=None):
        raise NotImplementedError


class _GraphWithKwargs:
    nodes = {}

    def astream_events(self, *args, **kwargs):
        raise NotImplementedError


class _GraphWithoutContext:
    nodes = {}

    def astream_events(self, input, subgraphs=False, version="v2"):
        raise NotImplementedError


class GetStreamKwargsTest(unittest.TestCase):
    def test_merges_context_for_named_context_parameter(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithNamedContext())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-1", "tenant": "from-config"}},
            context={"tenant": "from-context", "locale": "en"},
        )

        self.assertEqual(
            kwargs["context"],
            {"thread_id": "t-1", "tenant": "from-context", "locale": "en"},
        )

    def test_merges_context_for_kwargs_signature(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-2"}},
            context={"locale": "en"},
        )

        self.assertEqual(kwargs["context"], {"thread_id": "t-2", "locale": "en"})

    def test_omits_context_for_older_signature(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithoutContext())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-3"}},
            context={"locale": "en"},
        )

        self.assertNotIn("context", kwargs)
        self.assertEqual(kwargs["config"], {"configurable": {"thread_id": "t-3"}})


if __name__ == "__main__":
    unittest.main()
