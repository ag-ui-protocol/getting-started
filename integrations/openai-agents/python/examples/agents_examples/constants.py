"""Shared constants for the example agents.

These examples target **native OpenAI** as the model provider. The reference
examples exercise the straightforward OpenAI path: real ids and orderly
``output_item.done`` events. Point ``DEFAULT_MODEL`` at any Responses-API model
your ``OPENAI_API_KEY`` has access to.
"""

from __future__ import annotations

import os

DEFAULT_MODEL = os.getenv("OPENAI_DEFAULT_MODEL", "gpt-5.5")
