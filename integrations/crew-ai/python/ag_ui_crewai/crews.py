import uuid
import json
import weakref
from typing import Any, Protocol, cast, runtime_checkable
from crewai import Crew, Flow
from crewai.flow import start
# CPK-7718: the five crew-chat helpers moved from ``crewai.cli.crew_chat``
# (crewai 0.x - 1.14) to ``crewai.utilities.crew_chat`` (crewai 1.15+).
# ``_capabilities`` probes both locations (new path first) so the crew-serving
# path works across the whole ``crewai>=1.0`` floor. The module-level aliases
# below are preserved so tests can patch ``crews.crew_chat_*`` by name.
from ._capabilities import (
  initialize_chat_llm as crew_chat_initialize_chat_llm,
  generate_crew_chat_inputs as crew_chat_generate_crew_chat_inputs,
  generate_crew_tool_schema as crew_chat_generate_crew_tool_schema,
  build_system_message as crew_chat_build_system_message,
  create_tool_function as crew_chat_create_tool_function,
)
# ``litellm`` is a DIRECT dependency of ag-ui-crewai (CPK-7718 #6): crewai
# moved it to the optional ``crewai[litellm]`` extra at 1.0.0, so importing it
# ourselves keeps ``acompletion`` resolvable regardless of crewai extras.
from litellm import acompletion
from ._env import _parse_env_float
from ._copyutil import safe_deepcopy
from .sdk import (
  copilotkit_stream,
  copilotkit_exit,
  copilotkit_emit_state,
)

# Cache of generated chat-input schemas, keyed by the ``@CrewBase``
# instance passed to ``add_crewai_crew_fastapi_endpoint`` (CPK-7717
# review round 3, finding 2).
#
# The store maps ``id(crew) -> (weakref.ref(crew, evict_cb), schema)``.
# Keying by ``id`` alone was unsafe (CPython reuses ``id`` values after
# GC), and a ``WeakKeyDictionary`` keyed on the crew object was ALSO
# unsafe: it keys by ``__eq__`` / ``__hash__``, so two distinct-but-equal
# crew objects (e.g. value-based ``@dataclass``-style wrappers) collapse
# to one entry and cross-serve each other's schema. Combining the two —
# an ``id`` key plus a STRICT-IDENTITY weakref check — fixes both:
#
#   * ``evict_cb`` pops the ``id`` entry the moment its referent is
#     garbage-collected, so a later ``id`` reuse can never inherit a
#     stale schema.
#   * On read we only return the schema when the stored ``ref() is crew``
#     (strict identity, and still alive); anything else is a miss and the
#     stale entry is dropped so we regenerate.
#
# Genuinely NON-weak-referenceable crews are simply NOT cached: retaining
# a strong reference to keep the ``id`` stable would leak every such
# wrapper for the process lifetime, so we prefer correctness (regenerate)
# over the caching win for that rare shape.
_CREW_INPUTS_CACHE: "dict[int, tuple[weakref.ref, Any]]" = {}


def _crew_inputs_cache_get(crew: Any) -> Any:
    """Return the cached chat-input schema for ``crew`` or ``None`` on miss.

    ``None`` is an unambiguous miss sentinel: ``generate_crew_chat_inputs``
    always returns a populated ``ChatInputs`` object, never ``None``.

    Strict-identity + liveness check: the stored weakref must still point
    at *this exact* ``crew`` object. A dead weakref (referent collected)
    or a mismatch (``id`` reused by a different object) is a miss, and the
    stale entry is dropped so the caller regenerates rather than being
    served another crew's schema.
    """
    entry = _CREW_INPUTS_CACHE.get(id(crew))
    if entry is None:
        return None
    ref, schema = entry
    if ref() is crew:
        return schema
    # Dead referent, or ``id`` reused by a DIFFERENT object: drop the
    # stale entry so we regenerate.
    _CREW_INPUTS_CACHE.pop(id(crew), None)
    return None


def _crew_inputs_cache_set(crew: Any, schema: Any) -> None:
    """Cache ``schema`` for ``crew`` in the identity-safe store.

    Non-weak-referenceable crews are intentionally not cached (see the
    module comment) — no permanent strong reference is ever retained.
    """
    key = id(crew)

    def _evict(dead_ref: "weakref.ref") -> None:
        # Only evict if THIS entry is still the live one. Guards against
        # popping a freshly-stored entry whose crew happens to reuse the
        # collected crew's ``id``.
        existing = _CREW_INPUTS_CACHE.get(key)
        if existing is not None and existing[0] is dead_ref:
            _CREW_INPUTS_CACHE.pop(key, None)

    try:
        ref = weakref.ref(crew, _evict)
    except TypeError:
        # Not weak-referenceable: skip caching entirely rather than pin a
        # strong reference forever (which would leak the wrapper).
        return
    _CREW_INPUTS_CACHE[key] = (ref, schema)


@runtime_checkable
class CrewBaseInstance(Protocol):
    """Structural type for a ``@CrewBase``-decorated crew instance.

    ``add_crewai_crew_fastapi_endpoint`` and ``ChatWithCrewFlow`` require a
    crew wrapper exposing a ``crew()`` factory that builds the underlying
    :class:`crewai.Crew` — NOT a bare :class:`crewai.Crew`, which has no
    ``.crew()`` factory (annotating the parameter as ``Crew`` was actively
    misleading; CPK-7717 defect 5).

    The protocol pins ONLY ``crew()`` — the single structural essential
    (CPK-7717 review round 3, finding 3). Name handling is deliberately
    left OUT of the protocol and delegated to :func:`_read_crew_name`,
    which accepts a real ``@CrewBase`` instance's ``_crew_name`` OR a
    hand-rolled ``.name``. Requiring ``_crew_name`` in the protocol (as an
    earlier round did) wrongly rejected the repo's own ``CrewChatCrew``
    wrapper, which exposes only ``.name`` yet works at runtime.

    ``@runtime_checkable`` lets callers/tests assert conformance via
    ``isinstance`` (structural: method presence only).
    """

    def crew(self) -> Crew:  # pragma: no cover - structural protocol stub
        ...


def _read_crew_name(crew: Any) -> str:
    """Return a non-empty crew name from a ``@CrewBase`` instance.

    Accepts a hand-rolled ``.name`` OR crewai's canonical ``_crew_name``
    (set by the ``@CrewBase`` decorator to the class name). crewai's
    ``ChatInputs.crew_name`` is a required non-empty ``str`` and is used
    as the crew tool's function name, so a missing/empty/non-string name
    would raise a Pydantic validation error deep inside
    ``generate_crew_chat_inputs``. Fail loudly here with an actionable
    message instead (CPK-7717 review round 2, finding 2).
    """
    for attr in ("name", "_crew_name"):
        value = getattr(crew, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    raise ValueError(
        "Could not determine a crew name: the crew exposes neither a "
        "non-empty ``name`` nor ``_crew_name`` attribute. Pass a "
        "``@CrewBase``-decorated crew (crewai sets ``_crew_name`` to the "
        "decorated class name) or set a non-empty ``name`` — crewai's "
        "ChatInputs.crew_name requires a non-empty string."
    )

# Per-read idle guard (seconds) for LiteLLM streaming requests. LiteLLM
# forwards this to the underlying HTTP client, where it acts as a
# *per-read* / socket-recv timeout — NOT a session-level ceiling. That means
# a trickle-feeding server can still keep the coroutine alive indefinitely
# by sending a single byte before each timeout expires; the session-level
# cap for that scenario is enforced by ``AGUI_CREWAI_FLOW_TIMEOUT_SECONDS``
# in ``endpoint.py``. Override this per-read guard with the
# ``AGUI_CREWAI_LLM_TIMEOUT_SECONDS`` environment variable; set to a
# non-positive value to disable it (the outer flow ceiling still applies).
_DEFAULT_LLM_TIMEOUT_SECONDS = 120.0


def _llm_timeout_seconds() -> float | None:
    """Return the configured LLM read timeout, or ``None`` to disable it.

    A non-positive value (``0`` / negative) disables the read timeout. NaN
    and any other non-finite float is treated as unparseable and falls back
    to the default — ``float('nan') > 0`` is False, which would otherwise
    silently disable the guard. Mirrors the NaN handling in
    ``endpoint._flow_timeout_seconds`` (R5 HIGH #1).

    CR7 LOW: delegates to ``_env._parse_env_float`` so the three
    env-parsed float helpers (flow ceiling / cancel-join ceiling / LLM
    read timeout) share a single parse + policy path rather than
    triplicating the scaffolding. CR8 MEDIUM: the helper lives on a
    neutral ``_env`` module (rather than ``endpoint``) so we can
    import it at module load time without a circular dependency
    (``endpoint`` imports ``ChatWithCrewFlow`` from ``crews``).
    """
    return _parse_env_float(
        "AGUI_CREWAI_LLM_TIMEOUT_SECONDS",
        _DEFAULT_LLM_TIMEOUT_SECONDS,
        allow_disable=True,
    )


CREW_EXIT_TOOL = {
    "type": "function",
    "function": {
        "name": "crew_exit",
        "description": "Call this when the user has indicated that they are done with the crew",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
}


class ChatWithCrewFlow(Flow):
    """Chat with crew"""

    def __init__(
            self, *,
            crew: "CrewBaseInstance"
        ):
        super().__init__()


        # CPK-7718 #10: ``Crew`` is a Pydantic BaseModel carrying
        # non-deep-copyable runtime state (memory / locks) in crewai 1.15.x, so
        # a plain ``copy.deepcopy`` crashes. ``safe_deepcopy`` falls back to
        # pinning those shared objects by reference while still isolating
        # copyable state.
        self.crew = safe_deepcopy(cast(Any, crew).crew(), what="crew")

        if self.crew.chat_llm is None:
            raise ValueError("Crew chat LLM is not set")

        # Read the crew name from the real ``@CrewBase`` accessor
        # (``_crew_name``) or a hand-rolled ``.name`` — never ``crew.name``
        # unconditionally, which AttributeErrors on a real @CrewBase
        # instance (CPK-7717 review round 2, finding 2). Fails loudly with
        # an actionable message if neither yields a usable non-empty name,
        # rather than passing ``None`` into ``ChatInputs`` (validation
        # error deep in ``generate_crew_chat_inputs``).
        self.crew_name = _read_crew_name(crew)
        self.chat_llm = crew_chat_initialize_chat_llm(self.crew)

        # Identity-safe cache keyed on the crew object itself (finding 3),
        # not ``id(crew)`` which is reused after GC.
        cached = _crew_inputs_cache_get(crew)
        if cached is None:
            self.crew_chat_inputs = crew_chat_generate_crew_chat_inputs(
                self.crew,
                self.crew_name,
                self.chat_llm
            )
            _crew_inputs_cache_set(crew, self.crew_chat_inputs)
        else:
            self.crew_chat_inputs = cached

        self.crew_tool_schema = crew_chat_generate_crew_tool_schema(self.crew_chat_inputs)
        self.system_message = crew_chat_build_system_message(self.crew_chat_inputs)

    def _completion_llm_kwargs(self) -> dict:
        """Return the connection kwargs for a litellm ``acompletion`` call.

        Defect 1 (CPK-7717): the completion call sites previously passed
        the raw ``self.crew.chat_llm`` model STRING to ``acompletion``,
        which drops the credentials/endpoint that ``initialize_chat_llm``
        resolved. litellm then falls back to environment/default
        credentials, breaking local and self-hosted models
        (CopilotKit#2742).

        Round-2 review finding 1: forwarding only ``model`` / ``api_key``
        / ``base_url`` still dropped ``api_base`` / ``api_version`` and the
        provider-specific ``additional_params`` — so Azure and other
        custom-endpoint users still hit the wrong endpoint. crewai's own
        ``LLM._prepare_completion_params`` forwards the connection fields
        (``api_base``, ``base_url``, ``api_version``, ``api_key``), the
        generation config (``temperature``, ``top_p``, ``n``, ``stop``,
        ``max_tokens``/``max_completion_tokens``, ``presence_penalty``,
        ``frequency_penalty``, ``logit_bias``, ``response_format``, ``seed``,
        ``logprobs``, ``top_logprobs``, ``reasoning_effort``) AND spreads
        ``additional_params`` (see ``crewai/llm.py``); we mirror all of that
        here so both completion call sites behave exactly the way
        ``generate_crew_chat_inputs`` does (it drives the same LLM object).

        Defensive: ``getattr`` with a fall back to the crew's model string
        keeps the helper working if ``chat_llm`` was not resolved (e.g. in
        unit tests that construct the flow via ``__new__``). Every field is
        forwarded only when present/non-None so we never override litellm's
        own resolution with ``None``. ``additional_params`` is spread first
        so the explicit connection fields win on any key collision.
        """
        llm = getattr(self, "chat_llm", None)
        model = getattr(llm, "model", None) or self.crew.chat_llm
        kwargs: dict = {"model": model}

        additional = getattr(llm, "additional_params", None)
        if isinstance(additional, dict):
            for key, value in additional.items():
                if value is not None:
                    kwargs[key] = value

        # Connection fields AND generation config, matching what crewai's
        # LLM._prepare_completion_params forwards. Without the generation
        # config, a resolved chat_llm's temperature/max_tokens/etc. are
        # silently dropped and litellm applies provider defaults (e.g.
        # LLM(model="gpt-4o", temperature=0) would not be honored).
        for attr in (
            "api_key", "base_url", "api_base", "api_version",
            "temperature", "top_p", "n", "stop",
            "max_tokens", "max_completion_tokens",
            "presence_penalty", "frequency_penalty", "logit_bias",
            "response_format", "seed", "logprobs", "top_logprobs",
            "reasoning_effort",
        ):
            value = getattr(llm, attr, None)
            # Skip None and empty containers (crewai defaults `stop` to `[]`)
            # so we never override litellm's own resolution with a no-op.
            # temperature=0 and other explicit falsy-but-meaningful values
            # (0, 0.0) are preserved.
            if value is None or value == [] or value == {}:
                continue
            kwargs[attr] = value
        return kwargs

    def _completion_call_params(self, **call_owned: Any) -> dict:
        """Build the FULL kwargs dict for one ``acompletion`` call.

        Defect 1 (CPK-7717 review round 3): ``_completion_llm_kwargs``
        spreads the crewai ``LLM.additional_params``, which legitimately
        may contain keys each ``chat()`` call site ALSO sets explicitly —
        ``messages`` / ``tools`` / ``tool_choice`` / ``stream`` /
        ``timeout`` / ``parallel_tool_calls`` (e.g.
        ``LLM(model="gpt-4o", parallel_tool_calls=True)`` puts
        ``parallel_tool_calls`` in ``additional_params``). Passing such a
        key both via ``**connection`` AND as an explicit ``kw=`` argument
        raised ``TypeError: acompletion() got multiple values for keyword
        argument``.

        We funnel EVERYTHING through one dict here and let the CALL-OWNED
        settings win over anything from ``additional_params`` (they are
        the framework's fixed contract for the chat loop — e.g. we must
        keep ``parallel_tool_calls=False`` and ``stream=True`` regardless
        of user LLM extras). Call sites splat the result as
        ``acompletion(**self._completion_call_params(...))`` and never mix
        explicit ``kw=`` args with the splat, so no key is passed twice.
        """
        params = self._completion_llm_kwargs()
        params.update(call_owned)  # call-owned settings win on collision.
        return params

    @start()
    async def chat(self):
        """Chat with the crew"""

        system_message = self.system_message
        if self.state.get("inputs"):
            system_message += "\n\nCurrent inputs: " + json.dumps(self.state["inputs"])

        messages = [
            {
                "role": "system",
                "content": system_message,
                "id": str(uuid.uuid4()) + "-system"
            },
            *self.state["messages"]
        ]

        tools = [action for action in self.state["copilotkit"]["actions"]
                 if action["function"]["name"] != self.crew_name]

        tools += [self.crew_tool_schema, CREW_EXIT_TOOL]

        response = await copilotkit_stream(
            await acompletion(
                **self._completion_call_params(
                    messages=messages,
                    tools=tools,
                    parallel_tool_calls=False,
                    stream=True,
                    timeout=_llm_timeout_seconds(),
                )
            )
        )

        message = cast(Any, response).choices[0]["message"]
        self.state["messages"].append(message)

        if message.get("tool_calls"):
            if message["tool_calls"][0]["function"]["name"] == self.crew_name:
                # run the crew
                crew_function = crew_chat_create_tool_function(self.crew, messages)
                args = json.loads(message["tool_calls"][0]["function"]["arguments"])
                result = crew_function(**args)

                if isinstance(result, str):
                    self.state["outputs"] = result
                elif hasattr(result, "json_dict"):
                    self.state["outputs"] = result.json_dict
                elif hasattr(result, "raw"):
                    self.state["outputs"] = result.raw
                else:
                    raise ValueError("Unexpected result type", type(result))

                self.state["messages"].append({
                    "role": "tool",
                    "content": result,
                    "tool_call_id": message["tool_calls"][0]["id"]
                })

                # Defect 3 (CPK-7717): surface the state mutation from the
                # crew run so a StateSnapshotEvent reaches the bridge as
                # soon as the crew output is applied, rather than only at
                # method-finish. NOTE on granularity: this emits ONE
                # snapshot after the crew result lands. Per-tool /
                # intermediate mutations *inside* the crew run are not yet
                # observable here — surfacing those requires the CrewAI
                # StreamFrame integration tracked in CPK-7719. Until then
                # this is the finest granularity reachable without that
                # work. First blocker for that ticket (not StreamFrame
                # itself): ``result = crew_function(**args)`` above is a
                # SYNCHRONOUS ``crew.kickoff`` run on the event loop inside
                # this async ``@start()``, so it blocks SSE flushing and
                # prevents AGUI_CREWAI_FLOW_TIMEOUT_SECONDS / client-
                # disconnect cancellation from firing until the crew
                # returns. CPK-7719 needs ``asyncio.to_thread`` here.
                await copilotkit_emit_state(self.state)

                # Defect 2 (CPK-7717): a backend tool result on its own
                # leaves the assistant silent — the single-pass @start()
                # chat had no follow-up completion after the crew tool ran
                # (the crew_exit branch below always had one). Issue a
                # streamed follow-up so the assistant produces text about
                # the crew result. ``tool_choice="none"`` forces a text
                # answer, mirroring the crew_exit branch. LIMITATION: it
                # also blocks tool chaining — the assistant cannot call a
                # frontend action after a crew run, so "run the crew, then
                # update the UI" is unreachable on this path. Documented in
                # README next to the timeout wording; allowing bounded tool
                # re-entry here is future work.
                response = await copilotkit_stream(
                    await acompletion(
                        **self._completion_call_params(
                            messages=[
                                {
                                    "role": "system",
                                    "content": "The crew has finished running. "
                                               "Use the tool result to answer the "
                                               "user's request.",
                                    "id": str(uuid.uuid4()) + "-system"
                                },
                                *self.state["messages"]
                            ],
                            tools=tools,
                            parallel_tool_calls=False,
                            stream=True,
                            tool_choice="none",
                            timeout=_llm_timeout_seconds(),
                        )
                    )
                )
                message = cast(Any, response).choices[0]["message"]
                self.state["messages"].append(message)
            elif message["tool_calls"][0]["function"]["name"] == CREW_EXIT_TOOL["function"]["name"]:
                await copilotkit_exit()
                self.state["messages"].append({
                    "role": "tool",
                    "content": "Crew exited",  # E2E: aimock-setup.ts matches this exact string
                    "tool_call_id": message["tool_calls"][0]["id"]
                })

                response = await copilotkit_stream(
                    await acompletion(
                        **self._completion_call_params(
                            messages=[
                                {
                                    "role": "system",
                                    "content": "Indicate to the user that the crew has exited",
                                    "id": str(uuid.uuid4()) + "-system"
                                },
                                *self.state["messages"]
                            ],
                            tools=tools,
                            parallel_tool_calls=False,
                            stream=True,
                            tool_choice="none",
                            timeout=_llm_timeout_seconds(),
                        )
                    )
                )
                message = cast(Any, response).choices[0]["message"]
                self.state["messages"].append(message)
