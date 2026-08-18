import unittest

from pydantic import ValidationError

from ag_ui.core.events import (
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    TokenUsage,
)


class TokenUsageTest(unittest.TestCase):
    def test_full_entry(self):
        u = TokenUsage(
            provider="anthropic",
            model="claude-sonnet-4",
            input_tokens=100,
            output_tokens=50,
            total_tokens=150,
            reasoning_tokens=20,
            cached_input_tokens=10,
        )
        self.assertEqual(u.provider, "anthropic")
        self.assertEqual(u.total_tokens, 150)

    def test_all_fields_optional(self):
        u = TokenUsage()
        self.assertIsNone(u.input_tokens)

    def test_camel_case_serialization(self):
        u = TokenUsage(input_tokens=5, cached_input_tokens=2)
        dumped = u.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped, {"inputTokens": 5, "cachedInputTokens": 2})

    def test_rejects_non_numeric(self):
        with self.assertRaises(ValidationError):
            TokenUsage(input_tokens="lots")


class RunFinishedUsageTest(unittest.TestCase):
    def test_legacy_event_has_no_usage(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1")
        self.assertIsNone(e.usage)

    def test_usage_from_camel_case_dict(self):
        e = RunFinishedEvent.model_validate(
            {
                "type": EventType.RUN_FINISHED,
                "threadId": "t-1",
                "runId": "r-1",
                "usage": [
                    {"provider": "openai", "model": "gpt-4o", "inputTokens": 100, "totalTokens": 120},
                    {"provider": "openai", "model": "gpt-4o-mini", "inputTokens": 10},
                ],
            }
        )
        self.assertEqual(len(e.usage), 2)
        self.assertEqual(e.usage[1].model, "gpt-4o-mini")

    def test_legacy_serialization_omits_usage(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1")
        dumped = e.model_dump(by_alias=True, exclude_none=True)
        self.assertNotIn("usage", dumped)


class RunErrorUsageTest(unittest.TestCase):
    def test_no_usage(self):
        e = RunErrorEvent(message="boom")
        self.assertIsNone(e.usage)

    def test_partial_usage_on_failure(self):
        e = RunErrorEvent.model_validate(
            {
                "type": EventType.RUN_ERROR,
                "message": "boom",
                "usage": [{"provider": "anthropic", "inputTokens": 100}],
            }
        )
        self.assertEqual(e.usage[0].input_tokens, 100)


class TokenUsageCountConstraintsTest(unittest.TestCase):
    """
    Counts are non-negative in every binding. Pydantic already rejects a
    fractional value for an `int` field, but without an explicit bound it
    accepts a negative one — which would make Python able to emit a value the
    TypeScript schema now refuses to parse. Since TS consumers validate every
    incoming event and raise on failure, that asymmetry would surface as a
    dead run at the consumer rather than an actionable error at the producer.
    """

    COUNT_FIELDS = (
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "reasoning_tokens",
        "cached_input_tokens",
    )

    def test_rejects_negative_counts(self):
        for field in self.COUNT_FIELDS:
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    TokenUsage(**{field: -1})

    def test_accepts_zero_and_positive_counts(self):
        for field in self.COUNT_FIELDS:
            with self.subTest(field=field):
                self.assertEqual(getattr(TokenUsage(**{field: 0}), field), 0)
                self.assertEqual(getattr(TokenUsage(**{field: 7}), field), 7)

    def test_still_rejects_fractional_counts(self):
        with self.assertRaises(ValidationError):
            TokenUsage(input_tokens=1.5)

    def test_counts_remain_optional(self):
        usage = TokenUsage(provider="openai", model="gpt-4o")
        for field in self.COUNT_FIELDS:
            self.assertIsNone(getattr(usage, field))


if __name__ == "__main__":
    unittest.main()
