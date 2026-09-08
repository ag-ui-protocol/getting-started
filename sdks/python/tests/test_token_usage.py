"""
Tests for the vendor -> TokenUsage mappers and aggregation.

Mirrors sdks/typescript/packages/core/src/__tests__/token-usage.test.ts, plus
the Python-specific guard cases (see ``_num``'s docstring: the integer /
non-negative bound is enforced by the TokenUsage constructor the producer
itself calls, so an unguarded value raises inside the producer rather than at
the consumer).
"""

import math
import unittest

from ag_ui.core import (
    TokenUsage,
    aggregate_token_usage,
    token_usage_from_langchain_metadata,
)


def _dump(usage):
    """Serialize the way a producer does, so absent counts are visibly absent
    rather than present-as-None."""
    return usage.model_dump(by_alias=True, exclude_none=True)


class TokenUsageFromLangChainMetadataTest(unittest.TestCase):
    def test_maps_core_and_detail_fields(self):
        usage = token_usage_from_langchain_metadata(
            {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "input_token_details": {"cache_read": 10},
                "output_token_details": {"reasoning": 20},
            },
            provider="anthropic",
            model="claude-sonnet-4",
        )
        self.assertEqual(
            _dump(usage),
            {
                "provider": "anthropic",
                "model": "claude-sonnet-4",
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
                "reasoningTokens": 20,
                "cachedInputTokens": 10,
            },
        )

    def test_returns_none_for_missing_or_empty_metadata(self):
        self.assertIsNone(token_usage_from_langchain_metadata(None))
        self.assertIsNone(token_usage_from_langchain_metadata({}))
        self.assertIsNone(token_usage_from_langchain_metadata({}, provider="openai"))

    def test_omits_absent_fields_entirely(self):
        usage = token_usage_from_langchain_metadata({"input_tokens": 5})
        self.assertEqual(_dump(usage), {"inputTokens": 5})

    def test_reads_attribute_shaped_metadata(self):
        """Vendor payloads are dicts in every LangChain version, but an
        object-shaped one should lose nothing rather than read as "no usage"."""

        class Details:
            reasoning = 3

        class Meta:
            input_tokens = 9
            output_token_details = Details()

        usage = token_usage_from_langchain_metadata(Meta())
        self.assertEqual(_dump(usage), {"inputTokens": 9, "reasoningTokens": 3})


class TokenUsageGuardTest(unittest.TestCase):
    """Only finite, non-negative whole numbers survive. Everything else is
    dropped rather than forwarded: consumers validate every event, and the
    TokenUsage constructor the producer calls would raise on a bad count
    inside the terminal-event path — failing the whole run at its last event."""

    def test_drops_string_counts(self):
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": "100", "output_tokens": 5}, provider="openai"
        )
        self.assertIsNone(usage.input_tokens)
        self.assertEqual(usage.output_tokens, 5)

    def test_drops_none_counts(self):
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": None, "output_tokens": 5}
        )
        self.assertIsNone(usage.input_tokens)
        self.assertEqual(usage.output_tokens, 5)

    def test_drops_nan_and_infinity(self):
        usage = token_usage_from_langchain_metadata(
            {
                "input_tokens": float("nan"),
                "output_tokens": math.inf,
                "total_tokens": 7,
            },
            provider="openai",
        )
        self.assertIsNone(usage.input_tokens)
        self.assertIsNone(usage.output_tokens)
        self.assertEqual(usage.total_tokens, 7)

    def test_drops_negative_and_fractional_counts(self):
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": -1, "output_tokens": 1.5, "total_tokens": 4}
        )
        self.assertIsNone(usage.input_tokens)
        self.assertIsNone(usage.output_tokens)
        self.assertEqual(usage.total_tokens, 4)

    def test_drops_booleans(self):
        """``bool`` subclasses ``int`` in Python; ``True`` is not a count."""
        self.assertIsNone(
            token_usage_from_langchain_metadata({"input_tokens": True})
        )

    def test_accepts_integral_float(self):
        usage = token_usage_from_langchain_metadata({"input_tokens": 12.0})
        self.assertEqual(usage.input_tokens, 12)
        self.assertIsInstance(usage.input_tokens, int)

    def test_an_integer_too_large_to_be_a_float_is_dropped_not_raised(self):
        """Regression: the guard used ``math.isfinite`` first, which coerces to
        float and raises ``OverflowError`` on a large int
        (``math.isfinite(10**1000)``). A provider count big enough to trip that
        aborted the run from inside the guard whose whole job is to make bad
        metadata harmless — the worst possible failure mode for this code."""
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": 10**1000, "output_tokens": 5}
        )
        self.assertIsNone(usage.input_tokens)
        self.assertEqual(usage.output_tokens, 5)

    def test_a_huge_integer_in_every_slot_is_dropped_not_raised(self):
        """Every count field, including the nested detail ones, goes through
        the same guard — so every one of them must survive the value."""
        self.assertIsNone(
            token_usage_from_langchain_metadata(
                {
                    "input_tokens": 10**400,
                    "output_tokens": -(10**400),
                    "total_tokens": 10**1000,
                    "output_token_details": {"reasoning": 10**500},
                    "input_token_details": {"cache_read": 10**600},
                },
                provider="openai",
            )
        )

    def test_counts_beyond_the_safe_integer_wire_range_are_dropped(self):
        """The TypeScript protobuf decoder stops at ``Number.MAX_SAFE_INTEGER``,
        which is the narrowest ceiling across the bindings. A Python int has no
        such bound, so a value past it is rejected at the producer rather than
        becoming an encoder crash mid-stream."""
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": 2**53, "output_tokens": 2**53 - 1}
        )
        self.assertIsNone(usage.input_tokens)
        self.assertEqual(usage.output_tokens, 2**53 - 1)

    def test_a_float_beyond_the_wire_range_is_dropped(self):
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": 1e300, "output_tokens": 2}
        )
        self.assertIsNone(usage.input_tokens)
        self.assertEqual(usage.output_tokens, 2)

    def test_guards_nested_detail_fields(self):
        usage = token_usage_from_langchain_metadata(
            {
                "input_tokens": 1,
                "output_token_details": {"reasoning": "12"},
                "input_token_details": {"cache_read": None},
            }
        )
        self.assertIsNone(usage.reasoning_tokens)
        self.assertIsNone(usage.cached_input_tokens)

    def test_tolerates_non_object_detail_containers(self):
        usage = token_usage_from_langchain_metadata(
            {
                "input_tokens": 1,
                "output_token_details": "nope",
                "input_token_details": 7,
            }
        )
        self.assertEqual(_dump(usage), {"inputTokens": 1})

    def test_returns_none_when_no_usable_count_survives(self):
        """Not a labels-only entry and not zeros: "not reported" must stay
        distinct from a measured zero."""
        self.assertIsNone(
            token_usage_from_langchain_metadata(
                {"input_tokens": "nope"}, provider="openai", model="gpt-4o"
            )
        )
        self.assertIsNone(
            token_usage_from_langchain_metadata(
                {"input_tokens": float("nan"), "output_token_details": {"reasoning": None}},
                provider="openai",
            )
        )

    def test_reports_a_measured_zero_as_zero(self):
        usage = token_usage_from_langchain_metadata({"output_tokens": 0})
        self.assertEqual(_dump(usage), {"outputTokens": 0})


class TokenUsageContentSafetyTest(unittest.TestCase):
    """TokenUsage feeds anonymous usage telemetry. No content-bearing provider
    field may be copied into it, whatever the provider attaches alongside the
    counts."""

    CONTENT_BEARING = {
        "prompt": "what is the capital of France?",
        "completion": "Paris",
        "messages": [{"role": "user", "content": "secret"}],
        "text": "secret",
        "content": "secret",
        "input": "secret",
        "output": "secret",
        "thread_id": "t-1",
        "run_id": "r-1",
        "user_id": "u-1",
        "api_key": "sk-live-xxx",
    }

    def test_content_bearing_fields_are_not_copied(self):
        usage = token_usage_from_langchain_metadata(
            {"input_tokens": 3, "output_tokens": 4, **self.CONTENT_BEARING},
            provider="openai",
            model="gpt-4o",
        )
        dumped = _dump(usage)
        self.assertEqual(
            dumped,
            {
                "provider": "openai",
                "model": "gpt-4o",
                "inputTokens": 3,
                "outputTokens": 4,
            },
        )
        # Belt and braces: nothing anywhere in the serialized entry echoes a
        # supplied value, under any key spelling.
        serialized = usage.model_dump_json()
        for key, value in self.CONTENT_BEARING.items():
            self.assertNotIn(key, dumped)
            if isinstance(value, str):
                self.assertNotIn(value, serialized)

    def test_the_mapper_is_the_guard_because_the_type_allows_extras(self):
        """``ConfiguredBaseModel`` is ``extra="allow"`` protocol-wide, so the
        type does NOT refuse a content-bearing field — a direct construction
        keeps it. The numeric-only guarantee therefore rests on the mapper
        never passing a vendor payload through, which is what this asserts:
        whatever keys the payload has, the entry's keys stay inside the
        allowed set."""
        smuggled = TokenUsage(input_tokens=1, prompt="secret")
        self.assertIn("prompt", smuggled.model_dump_json())

        allowed = {
            "provider",
            "model",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "reasoningTokens",
            "cachedInputTokens",
        }
        mapped = token_usage_from_langchain_metadata(
            {
                "input_tokens": 1,
                "input_token_details": {"cache_read": 2, "prompt": "secret"},
                "output_token_details": {"reasoning": 3, "completion": "secret"},
                **self.CONTENT_BEARING,
            },
            provider="openai",
            model="gpt-4o",
        )
        self.assertLessEqual(set(_dump(mapped)), allowed)


class AggregateTokenUsageTest(unittest.TestCase):
    def test_returns_empty_for_empty_input(self):
        self.assertEqual(aggregate_token_usage([]), [])

    def test_sums_entries_for_the_same_provider_and_model(self):
        aggregated = aggregate_token_usage(
            [
                TokenUsage(
                    provider="openai",
                    model="gpt-4o",
                    input_tokens=100,
                    output_tokens=20,
                    total_tokens=120,
                ),
                TokenUsage(
                    provider="openai",
                    model="gpt-4o",
                    input_tokens=10,
                    output_tokens=5,
                    total_tokens=15,
                ),
            ]
        )
        self.assertEqual(len(aggregated), 1)
        self.assertEqual(
            _dump(aggregated[0]),
            {
                "provider": "openai",
                "model": "gpt-4o",
                "inputTokens": 110,
                "outputTokens": 25,
                "totalTokens": 135,
            },
        )

    def test_keeps_distinct_models_separate_in_first_seen_order(self):
        aggregated = aggregate_token_usage(
            [
                TokenUsage(provider="openai", model="gpt-4o", input_tokens=1),
                TokenUsage(provider="openai", model="gpt-4o-mini", input_tokens=2),
                TokenUsage(provider="openai", model="gpt-4o", input_tokens=3),
            ]
        )
        self.assertEqual([u.model for u in aggregated], ["gpt-4o", "gpt-4o-mini"])
        self.assertEqual(aggregated[0].input_tokens, 4)
        self.assertEqual(aggregated[1].input_tokens, 2)

    def test_distinct_providers_stay_separate(self):
        aggregated = aggregate_token_usage(
            [
                TokenUsage(provider="openai", model="m", input_tokens=1),
                TokenUsage(provider="anthropic", model="m", input_tokens=2),
            ]
        )
        self.assertEqual([u.provider for u in aggregated], ["openai", "anthropic"])

    def test_unlabelled_entries_group_together(self):
        aggregated = aggregate_token_usage(
            [TokenUsage(input_tokens=1), TokenUsage(input_tokens=2)]
        )
        self.assertEqual(len(aggregated), 1)
        self.assertEqual(_dump(aggregated[0]), {"inputTokens": 3})

    def test_a_field_only_some_members_report_is_summed_over_those_members(self):
        aggregated = aggregate_token_usage(
            [
                TokenUsage(provider="p", model="m", input_tokens=1, reasoning_tokens=7),
                TokenUsage(provider="p", model="m", input_tokens=2),
                TokenUsage(provider="p", model="m", input_tokens=3, reasoning_tokens=5),
            ]
        )
        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0].input_tokens, 6)
        self.assertEqual(aggregated[0].reasoning_tokens, 12)

    def test_a_field_no_member_reports_stays_unset(self):
        """Not zero: "not reported" must stay distinct from a measured zero."""
        aggregated = aggregate_token_usage(
            [
                TokenUsage(provider="p", model="m", input_tokens=1),
                TokenUsage(provider="p", model="m", input_tokens=2),
            ]
        )
        self.assertEqual(aggregated[0].input_tokens, 3)
        self.assertIsNone(aggregated[0].output_tokens)
        self.assertEqual(_dump(aggregated[0]), {"provider": "p", "model": "m", "inputTokens": 3})

    def test_a_reported_zero_survives_aggregation(self):
        aggregated = aggregate_token_usage(
            [
                TokenUsage(provider="p", model="m", input_tokens=1, output_tokens=0),
                TokenUsage(provider="p", model="m", input_tokens=2, output_tokens=0),
            ]
        )
        self.assertEqual(aggregated[0].output_tokens, 0)

    def test_does_not_mutate_its_inputs(self):
        first = TokenUsage(provider="p", model="m", input_tokens=1)
        second = TokenUsage(provider="p", model="m", input_tokens=2)
        aggregate_token_usage([first, second])
        self.assertEqual(first.input_tokens, 1)
        self.assertEqual(second.input_tokens, 2)


if __name__ == "__main__":
    unittest.main()
