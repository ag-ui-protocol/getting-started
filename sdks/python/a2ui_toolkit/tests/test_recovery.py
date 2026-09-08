"""Unit tests for ag_ui_a2ui_toolkit.recovery.

Mirrors ``a2ui-toolkit/src/__tests__/recovery.test.ts`` (OSS-162). The Python
loop is synchronous to match the synchronous LangGraph tool.
"""

from __future__ import annotations

import json
import unittest

from ag_ui_a2ui_toolkit import (
    MAX_A2UI_ATTEMPTS,
    A2UI_RECOVERY_ACTIVITY_TYPE,
    augment_prompt_with_validation_errors,
    format_validation_errors,
    run_a2ui_generation_with_recovery,
)

CATALOG = {"components": {"Row": {"required": ["children"]}, "HotelCard": {"required": ["name", "rating"]}}}

ROOT = {"id": "root", "component": "Row", "children": {"componentId": "card", "path": "/items"}}
GOOD_CARD = {"id": "card", "component": "HotelCard", "name": {"path": "name"}, "rating": {"path": "rating"}}
BAD_CARD = {"id": "card", "component": "HotelCard", "name": {"path": "name"}}  # missing required `rating`

GOOD_ARGS = {"surfaceId": "s1", "components": [ROOT, GOOD_CARD], "data": {"items": [{"name": "Ritz", "rating": 4.8}]}}
BAD_ARGS = {"surfaceId": "s1", "components": [ROOT, BAD_CARD], "data": {"items": [{"name": "Ritz", "rating": 4.8}]}}


def build_envelope(args):
    return json.dumps({"a2ui_operations": args["components"]})


class TestConstants(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(MAX_A2UI_ATTEMPTS, 3)
        self.assertEqual(A2UI_RECOVERY_ACTIVITY_TYPE, "a2ui_recovery")


class TestAugment(unittest.TestCase):
    errors = [{"code": "missing_required_prop", "path": "components[1].rating", "message": "missing required prop 'rating'"}]

    def test_no_errors_unchanged(self):
        self.assertEqual(augment_prompt_with_validation_errors("BASE", []), "BASE")

    def test_appends_fix_block(self):
        out = augment_prompt_with_validation_errors("BASE", self.errors)
        self.assertIn("BASE", out)
        self.assertIn("rating", out)
        self.assertIn(format_validation_errors(self.errors), out)


class TestRecoveryLoop(unittest.TestCase):
    def test_valid_first_attempt(self):
        calls = []
        def invoke(prompt, attempt):
            calls.append(attempt)
            return GOOD_ARGS
        res = run_a2ui_generation_with_recovery(base_prompt="P", catalog=CATALOG, invoke_subagent=invoke, build_envelope=build_envelope)
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["attempts"]), 1)
        self.assertEqual(len(calls), 1)
        self.assertIn("a2ui_operations", json.loads(res["envelope"]))

    def test_recovers_second_attempt_with_feedback(self):
        prompts = []
        def invoke(prompt, attempt):
            prompts.append(prompt)
            return BAD_ARGS if attempt == 1 else GOOD_ARGS
        res = run_a2ui_generation_with_recovery(base_prompt="P", catalog=CATALOG, invoke_subagent=invoke, build_envelope=build_envelope)
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["attempts"]), 2)
        self.assertFalse(res["attempts"][0]["ok"])
        self.assertTrue(res["attempts"][1]["ok"])
        self.assertIn("rating", prompts[1])

    def test_exhaustion_hard_failure(self):
        seen = []
        res = run_a2ui_generation_with_recovery(
            base_prompt="P", catalog=CATALOG,
            invoke_subagent=lambda p, a: BAD_ARGS,
            build_envelope=build_envelope,
            on_attempt=lambda rec: seen.append(rec),
        )
        self.assertFalse(res["ok"])
        self.assertEqual(len(res["attempts"]), MAX_A2UI_ATTEMPTS)
        self.assertEqual(len(seen), MAX_A2UI_ATTEMPTS)
        parsed = json.loads(res["envelope"])
        self.assertEqual(parsed["code"], "a2ui_recovery_exhausted")
        self.assertTrue(parsed["error"])
        self.assertIsInstance(parsed["attempts"], list)

    def test_max_attempts_override(self):
        calls = []
        res = run_a2ui_generation_with_recovery(
            base_prompt="P", catalog=CATALOG, config={"maxAttempts": 2},
            invoke_subagent=lambda p, a: (calls.append(a), BAD_ARGS)[1],
            build_envelope=build_envelope,
        )
        self.assertFalse(res["ok"])
        self.assertEqual(len(calls), 2)

    def test_missing_tool_call_is_retryable(self):
        res = run_a2ui_generation_with_recovery(
            base_prompt="P", catalog=CATALOG,
            invoke_subagent=lambda p, a: None if a == 1 else GOOD_ARGS,
            build_envelope=build_envelope,
        )
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["attempts"]), 2)
        self.assertFalse(res["attempts"][0]["ok"])


if __name__ == "__main__":
    unittest.main()
