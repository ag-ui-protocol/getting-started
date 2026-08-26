"""Bounded crewai LLM for the example flows that run a real crew.

A crew runs synchronously, so on the conversational path it sits on a thread the
request loop cannot kill. Two different bounds matter there, and crewai leaves
both unset:

* the provider read timeout. ``Agent(llm="openai/...")`` and
  ``Crew(chat_llm="openai/...")`` build their LLM from the bare model id with no
  ``timeout``, so the provider client falls back to its own default (600s on the
  OpenAI SDK). ``bounded_llm`` carries the configured one instead.
* the per-execution ceiling. The read timeout does NOT bound a turn: crewai
  MULTIPLIES it (the OpenAI SDK retries each call ``max_retries=2`` times, the
  executor loops up to ``max_iter=25`` times, and a failed execution is retried
  ``max_retry_limit=2`` times), so 120s per read composes into hours inside one
  turn. ``Agent(max_execution_time=...)`` is the knob that trims that product;
  ``_config.resolve_agent_execution_ceiling_seconds`` derives it, and the flows
  here pass it alongside the LLM.

Neither closes the abandoned-worker window, and the ceiling does not close it
either: crewai runs the timed execution inside a ``with ThreadPoolExecutor()``
(``crewai/agent/core.py:911-921``) whose exit joins the worker, so once the work is
running ``future.cancel()`` is a no-op and the caller is released only when the
execution really ends. Measured against crewai 1.15.11: a 0.5s bound around 3s of
work returned at 3.00s. What the ceiling removes is the task-retry factor, not the
wall clock. See the README's "What actually bounds an abandoned worker".
"""

import os

from crewai import LLM
from crewai.llms.base_llm import BaseLLM

from ag_ui_crewai._config import resolve_provider_timeout_seconds

# crewai's own env-derived resolution, which lives in
# ``utilities.llm_utils._llm_via_environment_or_fallback`` and therefore runs only
# for an agent given NO llm at all. Mirrored here (same variables, same
# precedence, including crewai's cross-fill below) so pinning an LLM to carry a
# timeout does not cost a deployment its mock-LLM model id or its alternate
# endpoint.
_MODEL_ENV_VARS = ("MODEL", "MODEL_NAME", "OPENAI_MODEL_NAME")
_BASE_URL_ENV_VARS = ("BASE_URL", "OPENAI_API_BASE", "OPENAI_BASE_URL")
_API_BASE_ENV_VARS = ("API_BASE", "AZURE_API_BASE")


def _first_env(names: tuple[str, ...]) -> str | None:
    """First non-empty value among ``names``, or ``None`` when none is set.

    Truthiness, not ``is not None``: crewai skips an empty variable on these
    chains, so an exported-but-blank ``BASE_URL`` must not win over the next one.
    """
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def bounded_llm(default_model: str) -> BaseLLM:
    """A crewai LLM carrying the configured provider read timeout.

    Annotated ``BaseLLM``, not ``LLM``: ``LLM.__new__`` is a factory that routes
    ``gpt-*`` ids to ``OpenAICompletion``, which implements ``BaseLLM`` but is not
    an ``LLM`` subclass, so ``isinstance(bounded_llm(...), LLM)`` is False.

    ``default_model`` is the fallback, not an override: an env-supplied model id
    wins, exactly as it does for an agent that sets no llm at all. Everything is
    resolved per call rather than once at import, so an operator retuning a
    variable does not have to know which import froze the value.

    A FRESH instance per caller, deliberately, even though building one eagerly
    constructs a sync and an async provider client
    (``OpenAICompletion._init_clients``). A crewai LLM is not safe to share
    between flows: ``Crew.kickoff`` with streaming calls
    ``enable_agent_streaming``, which sets ``agent.llm.stream = True`` on the
    instance and never restores it (``crewai/crews/utils.py:54``), so one flow's
    streaming setting would follow a shared object into every other flow on the
    same model. ``model_copy()`` is not the way out either: it isolates the
    ``stream`` field but hands over the SAME ``_token_usage`` dict, which crewai
    mutates in place (``crewai/llms/base_llm.py:958``), so two flows would then
    accumulate one another's token counts. Both verified against crewai 1.15.11.
    """
    model = _first_env(_MODEL_ENV_VARS) or default_model
    base_url = _first_env(_BASE_URL_ENV_VARS)
    api_base = _first_env(_API_BASE_ENV_VARS)
    # crewai fills each of these from the other when only one is set: the native
    # OpenAI provider reads ``base_url`` and Azure reads ``api_base``, so dropping
    # the cross-fill would leave one of them blind to the other's variable. After
    # it the two are set or unset together, so one guard covers both.
    base_url, api_base = base_url or api_base, api_base or base_url

    connection = {}
    if base_url:
        connection["base_url"] = base_url
        connection["api_base"] = api_base
    return LLM(model=model, timeout=resolve_provider_timeout_seconds(), **connection)
