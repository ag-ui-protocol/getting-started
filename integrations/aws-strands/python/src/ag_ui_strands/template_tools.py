"""Per-request filtering of the tools the template agent contributed.

The adapter builds one Strands ``Agent`` per thread and keeps it. That instance
is load-bearing: it holds the thread's ``SessionManager``, its native interrupt
checkpoint and its conversation history. Changing which tools a request sees
therefore has to be done to the registry the live instance already owns, the
way client-declared tools are already synchronised, and never by constructing a
replacement.

Scope is the template's own tools. Client-declared tools arrive on
``RunAgentInput.tools`` every request and are synchronised by
:func:`~ag_ui_strands.client_proxy_tool.sync_proxy_tools`; a caller that wants
fewer of those sends fewer. Auto-injected A2UI tools are the adapter's and are
refreshed per turn. What no per-request channel reached until now is the set the
wrapped template contributed once, at construction.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping, Optional, Sequence, Set

from strands.hooks import BeforeModelCallEvent, HookProvider, HookRegistry
from strands.tools.registry import ToolRegistry

from .a2ui_tool import is_auto_injected_a2ui_tool
from .client_proxy_tool import _is_proxy

logger = logging.getLogger(__name__)

# The narrowed name set for the run in flight, stamped on the per-thread agent
# so the re-narrowing hook can read it back. Not routed through ``agent.state``
# on purpose: that dict is persisted by a ``SessionManager``, and this is
# per-request scratch that must not outlive the process.
_ALLOWED_ATTR = "_ag_ui_template_tools_allowed"

_UNSET = object()


class _ExemptEveryTemplateTool:
    """Sentinel: hold every template tool, whatever the selection says."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "EXEMPT_EVERY_TEMPLATE_TOOL"


EXEMPT_EVERY_TEMPLATE_TOOL = _ExemptEveryTemplateTool()
"""What :func:`parked_batch_tool_names` answers for a checkpoint it cannot read.

A distinct value rather than ``None``: ``None`` already means "no exemptions"
everywhere ``exempt_names`` is passed, and the two are opposites.
"""


class TemplateToolsSelectionError(ValueError):
    """A provider answer this hook cannot read as a selection of tools.

    Raised at the boundary rather than absorbed, so the run reports
    ``TEMPLATE_TOOLS_PROVIDER_ERROR`` and stops. The alternative, guessing what
    an unreadable answer meant, is the one thing a hook that withholds
    capability must not do.
    """


def index_template_tools(template_tools: Sequence[Any]) -> dict[str, Any]:
    """Index the template's tools by the name a registry holds them under."""
    indexed: dict[str, Any] = {}
    for tool in template_tools:
        name = getattr(tool, "tool_name", None)
        if isinstance(name, str) and name:
            indexed[name] = tool
    return indexed


def resolve_template_tool_selection(
    selection: Optional[Iterable[Any]],
    template_index: Mapping[str, Any],
) -> Optional[Set[str]]:
    """Read one provider answer as the template tool names a request may see.

    Entries are either the template's own tool objects or their names, so a
    caller can write the filter with whichever it has to hand.

    ``None`` means the provider declined to filter this request and every
    template tool stays available. An empty iterable is a real answer and means
    none of them do.

    The container is checked rather than merely iterated. A ``str`` and a
    ``Mapping`` are both iterable and both mean something other than what
    iterating them produces: a name would come apart into characters, and a
    permission map would have its keys read as an allow-list while its values
    went unread, which authorizes every key including the ones mapped to
    ``False``. TypeScript's ``for...of`` already refuses a plain object, so
    refusing a mapping here is also what keeps one return contract across the
    two bridges rather than two.

    A name the template never contributed is dropped with a warning. This hook
    narrows what the wrapped agent already gave the adapter; it cannot hand the
    model a capability the template did not carry, so honouring an unknown name
    is the one thing it must not do.

    Raises:
        TemplateToolsSelectionError: If the answer is not a container of names
            or tools. The run reports ``TEMPLATE_TOOLS_PROVIDER_ERROR``.
    """
    if selection is None:
        return None

    if isinstance(selection, (str, bytes, bytearray)):
        raise TemplateToolsSelectionError(
            "template_tools_provider returned a single "
            f"{type(selection).__name__}, which iterates one character at a "
            "time and would deny every tool. Return a container of the tool "
            "names or tools this request may see, such as [\"a_tool\"]"
        )
    if isinstance(selection, Mapping):
        raise TemplateToolsSelectionError(
            f"template_tools_provider returned a {type(selection).__name__}, "
            "whose keys would be read as the allow-list while its values went "
            "unread, so a name mapped to False would still be allowed. Return "
            "a container holding only the tool names or tools this request may "
            "see"
        )
    try:
        entries = list(selection)
    except TypeError as exc:
        raise TemplateToolsSelectionError(
            f"template_tools_provider returned {type(selection).__name__}, "
            "which is not a container of tool names or tools"
        ) from exc

    allowed: Set[str] = set()
    for entry in entries:
        name = entry if isinstance(entry, str) else getattr(entry, "tool_name", None)
        if not isinstance(name, str) or not name:
            logger.warning(
                "template_tools_provider returned an entry that names no tool: %r",
                entry,
            )
            continue
        if name not in template_index:
            logger.warning(
                "template_tools_provider named %r, which the template agent does "
                "not contribute; it stays unavailable. This hook filters the "
                "template's tools and cannot add one.",
                name,
            )
            continue
        allowed.add(name)
    return allowed


def parked_batch_tool_names(agent: Any) -> "Set[str] | _ExemptEveryTemplateTool":
    """Tool names in the batch a live interrupt checkpoint would resume.

    A parked run resumes into the tool batch it stopped inside: Strands
    re-dispatches every ``toolUse`` in the assistant message it checkpointed,
    answering the ones that already completed from the checkpoint and running
    the one that is waiting. A tool absent from the registry at that moment
    turns the human's answer into a "tool not found" the model then re-fires,
    so nothing in that batch is filtered out while the pause is open.

    This is the same rule ``sync_proxy_tools`` applies through ``exempt_names``
    to a proxy parked in a frontend-tool interrupt, read off the checkpoint
    instead of off the frontend-wait index because a template tool can park
    through the approval hook, through an interrupt of its own, or not at all,
    and the batch answers all three at once.

    Returns:
        The names to hold registered; an empty set when nothing is parked; or
        :data:`EXEMPT_EVERY_TEMPLATE_TOOL` for a checkpoint that is carrying a
        tool batch this function cannot read, where holding everything costs
        one unfiltered turn and the alternative breaks a resume. An activated
        checkpoint with no ``tool_use_message`` at all is not that case: an
        interrupt raised before any tool ran parks exactly that way, and it has
        no batch to protect.
    """
    state = getattr(agent, "_interrupt_state", None)
    if state is None or getattr(state, "activated", False) is not True:
        return set()
    context = getattr(state, "context", None)
    if not isinstance(context, Mapping):
        logger.warning(
            "An activated interrupt checkpoint carries no readable context; "
            "holding every template tool registered rather than risk removing "
            "one this thread's resume is about to re-dispatch."
        )
        return EXEMPT_EVERY_TEMPLATE_TOOL
    if "tool_use_message" not in context:
        # A pause raised before any tool ran. Nothing is mid-dispatch, so
        # nothing needs holding.
        return set()

    message = context["tool_use_message"]
    names: Set[str] = set()
    if isinstance(message, Mapping):
        for block in message.get("content") or []:
            tool_use = block.get("toolUse") if isinstance(block, Mapping) else None
            if not isinstance(tool_use, Mapping):
                continue
            name = tool_use.get("name")
            if isinstance(name, str) and name:
                names.add(name)
    if not names:
        logger.warning(
            "An activated interrupt checkpoint carries a tool batch this "
            "adapter cannot read (%s); holding every template tool registered "
            "rather than risk removing one this thread's resume is about to "
            "re-dispatch.",
            type(message).__name__,
        )
        return EXEMPT_EVERY_TEMPLATE_TOOL
    return names


def _is_foreign_entry(entry: Any) -> bool:
    """Whether a registry entry belongs to a producer other than the template.

    The adapter has exactly two others: proxies for client-declared tools, and
    the A2UI tool it injects itself. Both are re-decided every turn by the code
    that owns them, so neither is this filter's to touch.
    """
    return _is_proxy(entry) or is_auto_injected_a2ui_tool(entry)


def _is_template_entry(entry: Any, template_tool: Any) -> bool:
    """Whether a registry entry under a template tool's name is the template's.

    Identity settles it when it holds. It does not always hold: with an
    external ``agents_by_thread`` map the wrapper is rebuilt per request while
    the cached thread agent keeps the registry it already had, so a template
    whose tools are built per request (a factory, or a closure over a
    request-scoped handle) hands the adapter equivalent but not identical
    objects. Reading a non-match as "someone else owns this name" would make a
    deny-everything answer remove nothing, which is a silent failure in the
    permissive direction on a hook whose whole job is withholding capability.

    So the fallback is ownership by elimination: the name is one the template
    contributes, and the entry sitting on it is not one of the adapter's other
    producers, therefore it is the template's.
    """
    if entry is template_tool:
        return True
    return not _is_foreign_entry(entry)


def apply_template_tool_selection(
    tool_registry: ToolRegistry,
    template_tools: Sequence[Any],
    allowed: Optional[Set[str]],
    *,
    exempt_names: "Set[str] | _ExemptEveryTemplateTool | None" = None,
) -> Set[str]:
    """Make *tool_registry* hold exactly the template tools *allowed* permits.

    ``allowed`` is a resolved name set, ``None`` meaning no filtering.
    ``exempt_names`` holds names to keep registered whatever ``allowed`` says;
    ``None`` exempts nothing and :data:`EXEMPT_EVERY_TEMPLATE_TOOL` exempts
    every name.

    Removal is not destructive. The template tool objects outlive the registry
    entry, so a later request that allows a name again restores the same
    instance, and history stays untouched throughout: a filtered-out tool's
    earlier calls and results remain in the thread's messages, which is what
    lets the model read what it already did with a tool it can no longer call.

    Returns the template tool names the registry holds after the call.
    """
    template_index = index_template_tools(template_tools)
    exempt_all = exempt_names is EXEMPT_EVERY_TEMPLATE_TOOL
    exempt_set: Set[str] = set() if exempt_all or exempt_names is None else exempt_names  # type: ignore[assignment]

    registered: Set[str] = set()
    for name, tool in template_index.items():
        exempt = exempt_all or name in exempt_set
        keep = allowed is None or name in allowed or exempt
        existing = tool_registry.registry.get(name)

        if not keep:
            if existing is not None and _is_template_entry(existing, tool):
                del tool_registry.registry[name]
                tool_registry.dynamic_tools.pop(name, None)
                logger.debug("Filtered out template tool: %s", name)
            elif existing is not None:
                logger.debug(
                    "Template tool %s is held by another producer; the filter "
                    "leaves it in place",
                    name,
                )
            continue

        if existing is tool:
            registered.add(name)
            continue
        if existing is None:
            _restore(tool_registry, name, tool)
            registered.add(name)
            continue
        if not exempt and _is_proxy(existing):
            # A client proxy took this name while the template tool was
            # filtered out, and the provider now allows the template tool. A
            # native tool wins a name collision, so hand the name back: the
            # proxy sync runs after this and re-decides the client's side,
            # skipping a name a native tool holds. Leaving the proxy would both
            # shadow the allowed tool and, if the client has stopped declaring
            # it, let the proxy sync drop the name outright.
            #
            # Guarded on ``not exempt`` rather than on the selection, because
            # the keep branch is also reached by exemption, and a proxy the
            # parked batch is answering keeps its name.
            del tool_registry.registry[name]
            tool_registry.dynamic_tools.pop(name, None)
            _restore(tool_registry, name, tool)
            registered.add(name)
            logger.debug(
                "Reclaimed template tool %s from a client proxy holding its name",
                name,
            )
            continue
        if _is_template_entry(existing, tool):
            # The template's, under a different object. Leave the entry the
            # thread has been using rather than churn it.
            registered.add(name)
            continue
        logger.debug(
            "Template tool %s is held by another producer; leaving it in place",
            name,
        )
    return registered


def _restore(tool_registry: ToolRegistry, name: str, tool: Any) -> None:
    """Put a template tool back under its name.

    By assignment rather than through ``register_tool``, which raises over a
    name that normalizes onto an existing one. Nothing new is being registered
    here: the entry is the one the template already put in this registry, so
    validating it again could only fail a run over a collision the construction
    it came from had accepted.
    """
    tool_registry.registry[name] = tool
    if getattr(tool, "is_dynamic", False):
        tool_registry.dynamic_tools[name] = tool


def sync_template_tools(
    tool_registry: ToolRegistry,
    template_tools: Sequence[Any],
    selection: Optional[Iterable[Any]],
    *,
    exempt_names: "Set[str] | _ExemptEveryTemplateTool | None" = None,
) -> Set[str]:
    """Read *selection* and apply it to *tool_registry* in one call.

    The run path keeps the two halves apart, so that reading a provider's
    answer fails as a provider error and applying it does not. This composes
    them for a caller with an answer already in hand.
    """
    return apply_template_tool_selection(
        tool_registry,
        template_tools,
        resolve_template_tool_selection(
            selection, index_template_tools(template_tools)
        ),
        exempt_names=exempt_names,
    )


def record_template_tool_selection(agent: Any, allowed: Optional[Set[str]]) -> None:
    """Publish the run's narrowed name set for the re-narrowing hook to read."""
    setattr(agent, _ALLOWED_ATTR, allowed)


class TemplateToolsNarrowingHook(HookProvider):
    """Re-narrow the filtered set once a resumed batch has been dispatched.

    The parked-batch exemption keeps a denied tool registered so a resume can
    reach it. Strands then carries on inside the same run: it re-dispatches the
    batch, clears the checkpoint, and makes its next model call from this same
    registry, which would still be advertising what the request denied. Without
    this hook the model could call a withheld tool for the rest of that run,
    and only the next request would narrow again.

    Strands reads the registry fresh before every model call and announces that
    read through ``BeforeModelCallEvent``, so that is where the narrowing is
    re-applied.

    No exemption is passed. By the time this fires the parked batch has been
    dispatched, which is the whole reason the exemption existed, so re-reading
    the checkpoint would only ask a question whose answer no longer matters,
    and the answer moved between SDK releases: the TypeScript SDK clears its
    pending execution at different points in 1.1 and 1.16, so a hook that
    reads it holds the exemption on one release and drops it on the other.
    Asking nothing is both simpler and the same on every release.

    A run the SDK is cancelling can replay a skipped batch after this fires,
    and a tool this narrowing removed would be missing from that replay. The
    run is being torn down at that point, and the next request restores
    whatever a live checkpoint still needs before anything reads the registry
    again.
    """

    def __init__(self, template_tools: Sequence[Any]) -> None:
        self._template_tools = template_tools

    def register_hooks(self, registry: HookRegistry, **_kwargs: Any) -> None:
        registry.add_callback(BeforeModelCallEvent, self._narrow)

    def _narrow(self, event: Any) -> None:
        agent = getattr(event, "agent", None)
        if agent is None:
            return
        allowed = getattr(agent, _ALLOWED_ATTR, _UNSET)
        if allowed is _UNSET or allowed is None:
            return
        apply_template_tool_selection(
            agent.tool_registry,
            self._template_tools,
            allowed,
        )
