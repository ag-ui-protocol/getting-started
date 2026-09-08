"""Shared model identifiers for live/integration tests.

Centralizing these here means a forced model cutover (Gemini deprecations come
on a schedule) is a one-line change instead of a sweep across every test file.
Both values are env-overridable so CI can pin a model without code edits.
"""

import os

# Default "flash" model used by the bulk of live integration tests.
# gemini-2.0-flash reached its shutdown date (2026-06-01); we leapfrog 2.5-flash
# (shuts down 2026-10-16) straight to the current stable flash GA.
LIVE_TEST_MODEL = os.getenv("ADK_TEST_MODEL", "gemini-3.5-flash")

# High-reasoning / "pro" model for tests that need it. Held at 2.5-pro for now.
# Note: gemini-2.5-pro also shuts down 2026-10-16 — revisit before then.
LIVE_TEST_PRO_MODEL = os.getenv("ADK_TEST_PRO_MODEL", "gemini-2.5-pro")
