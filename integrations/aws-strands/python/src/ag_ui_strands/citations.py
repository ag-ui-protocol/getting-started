"""Model citations, folded onto the assistant message they annotate.

When a model answers over documents with citations enabled, it returns the
source passages its answer came from. Strands surfaces each one as a
``CitationStreamEvent`` between the text deltas of the same turn, so a citation
arrives in the middle of the message it belongs to rather than at the end of the
run.

They ride the assistant message's own ``metadata`` under
:data:`CITATIONS_METADATA_KEY`, which is what keeps a citation attached to the
thing it annotates. A separate event stream would hand the frontend two
sequences and the job of correlating them.

Two envelopes exist across the supported Strands range, because
``CitationStreamEvent`` changed shape mid-1.x. Verified by downloading each
published wheel and reading ``strands/types/_events.py``::

    1.15.0 - 1.20.0   {"callback": {"citation": ..., "delta": ...}}
    1.21.0 - latest   {"citation": ..., "delta": ...}

Both are read here. The second is also the reason nothing in this module ever
forwards a whole event: from 1.21.0 the ``delta`` key is top level, so
``ModelStreamEvent.prepare()`` merges the live ``Agent`` -- system prompt,
message history, model config -- into the same dict. Only the citation object
itself is read out of it.

The normalisation below is written against ``citations.ts`` in the TypeScript
adapter, field for field, because the two are expected to emit the same object
for the same Bedrock response. Where they cannot agree, the difference is named
in the docstring that owns it rather than left for a reader to discover.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

#: Metadata key carrying the citation list on an assistant message.
#:
#: Deliberately not nested under AG-UI's reserved ``ag-ui`` key. That key is
#: reserved for the protocol's own values, and metadata merging replaces a
#: key's value wholesale rather than blending it, so a second writer under
#: ``ag-ui`` would silently destroy whatever the protocol had put there.
CITATIONS_METADATA_KEY = "citations"

#: Location kinds whose Bedrock wrapper key differs from the discriminator the
#: Strands TypeScript SDK produces for the same location.
#:
#: Only one differs today. Verified against the published SDK's
#: ``_mapBedrockCitationLocation``: Bedrock wraps a search-result location in
#: ``searchResultLocation`` and the SDK emits ``type: "searchResult"``, while
#: ``documentChar``, ``documentPage``, ``documentChunk`` and ``web`` keep their
#: names. Without this rename the two adapters would disagree on that one kind.
_LOCATION_KIND_ALIASES = {"searchResultLocation": "searchResult"}


def citation_from_event(event: Any) -> Optional[Dict[str, Any]]:
    """Return the citation object carried by ``event``, or ``None``.

    A citation is only recognised alongside its ``delta`` sibling, matching how
    Strands constructs the event. An event carrying an unpaired ``citation``
    key comes from somewhere else and belongs to the RAW fallback, which exists
    for exactly the events this adapter has no branch for.
    """
    if not isinstance(event, dict):
        return None

    for container in (event, event.get("callback")):
        if not isinstance(container, dict):
            continue
        citation = container.get("citation")
        if isinstance(citation, dict) and isinstance(container.get("delta"), dict):
            return citation

    return None


def _text_entries(value: Any) -> List[Dict[str, str]]:
    """Keep the non-empty ``{"text": ...}`` entries of a citation content list.

    Dropping the empty ones is load-bearing for cross-language agreement: the
    TypeScript Strands SDK coalesces a missing text to ``""`` where Python
    leaves the entry out entirely.
    """
    if not isinstance(value, list):
        return []
    return [
        {"text": entry["text"]}
        for entry in value
        if isinstance(entry, dict) and isinstance(entry.get("text"), str) and entry["text"]
    ]


def normalize_location(location: Any) -> Optional[Dict[str, Any]]:
    """Return a citation location in discriminated form, or ``None`` if empty.

    Bedrock sends the location wrapped in the key naming its kind
    (``{"documentChar": {"documentIndex": 0, "start": 1, "end": 9}}``), while
    the TypeScript Strands SDK hands its adapter the flattened, discriminated
    form (``{"type": "documentChar", ...}``). Both shapes arrive here, because
    a custom model provider can forward either, and both are reduced to the
    flattened one.

    Four rules, each mirrored in ``citations.ts``:

    * the wrapper key becomes ``type``, renamed through
      :data:`_LOCATION_KIND_ALIASES` where the SDK uses a different name;
    * fields the provider left empty or absent are dropped, matching the SDK,
      which omits a falsy ``domain`` rather than emitting it;
    * a location that ends up naming only its kind is not a location;
    * a location not discriminated by a non-empty string ``type`` is not a
      location either. Reached when a wrapper's payload is not an object
      (``{"documentChar": "0-9"}``), which would otherwise pass through as
      provider garbage and rescue a citation that names no source.

    The unwrap is structural rather than a list of known kinds, so a variant
    added after this was written still reaches a Python client. It will NOT
    reach a TypeScript one: the SDK's own Bedrock mapper logs and returns
    nothing for a kind it does not recognise, dropping the citation with it.
    That difference is upstream and cannot be normalised away here.
    """
    if not isinstance(location, dict):
        return None

    flattened: Dict[str, Any]
    if len(location) == 1:
        kind, fields = next(iter(location.items()))
        if isinstance(fields, dict) and "type" not in fields:
            flattened = {"type": _LOCATION_KIND_ALIASES.get(kind, kind), **fields}
        else:
            flattened = dict(location)
    else:
        flattened = dict(location)

    trimmed = {
        key: value
        for key, value in flattened.items()
        if value is not None and value != ""
    }

    if not isinstance(trimmed.get("type"), str) or not trimmed["type"]:
        return None
    if set(trimmed) == {"type"}:
        return None
    return trimmed


def _json_round_trip(value: Any) -> Any:
    """A deep copy of ``value``, or ``None`` if it will not survive JSON.

    Metadata rides an event that is encoded for the SSE stream, and a value
    that will not encode fails the whole stream, costing the client its
    ``TEXT_MESSAGE_END``, snapshots and ``RUN_FINISHED``. ``allow_nan=False``
    rejects NaN and +/-Infinity, which the default would emit as bare tokens
    that are not valid JSON. The except clause is broad on purpose: a deeply
    nested value raises ``RecursionError``, which is neither ``TypeError`` nor
    ``ValueError`` and would otherwise escape the guard and kill the stream the
    guard exists to protect.
    """
    try:
        return json.loads(json.dumps(value, allow_nan=False))
    except Exception:
        return None


def _describe_keys(value: Dict[str, Any]) -> str:
    """Render a dict's keys for a log line without assuming they sort.

    A malformed citation is exactly where mixed-type keys turn up, and this
    runs on the path that exists to survive one.
    """
    return ",".join(sorted(str(key) for key in value))


def normalize_citation(citation: Any, text_offset: int) -> Optional[Dict[str, Any]]:
    """Reduce a Strands citation to the wire shape, or ``None`` to drop it.

    Empty strings, empty lists and empty locations are omitted rather than
    emitted. The TypeScript SDK coalesces a missing ``source`` or ``title`` to
    ``""`` while Python leaves the key out, so keeping the empties would make
    the two bridges disagree about a citation that is identical on the provider
    side.

    A citation that names no source is dropped outright. The generated span is
    not one of those fields, and on this side it is not available at all: see
    the note below the guard.

    Serializability is checked rather than assumed: see
    :func:`_json_round_trip`.
    """
    if not isinstance(citation, dict):
        logger.warning("Dropping a citation that is not an object: %r", type(citation))
        return None

    entry: Dict[str, Any] = {}

    for field in ("title", "source"):
        value = citation.get(field)
        if isinstance(value, str) and value:
            entry[field] = value

    raw_location = citation.get("location")
    location = normalize_location(raw_location)
    if location is not None:
        entry["location"] = location
    elif raw_location:
        # Kept, minus the location. A provider that sends an untagged shape
        # still named a source; dropping the whole citation over a field this
        # adapter cannot place would lose more than it protects.
        logger.warning(
            "Omitting a citation location that is not in tagged form "
            "(keys=%s). A location must be either Bedrock's single-key "
            "wrapper or a discriminated object with a string `type`.",
            _describe_keys(raw_location)
            if isinstance(raw_location, dict)
            else type(raw_location).__name__,
        )

    source_content = _text_entries(citation.get("sourceContent"))
    if source_content:
        entry["sourceContent"] = source_content

    if not entry:
        logger.warning(
            "Dropping a citation carrying no source fields (keys=%s)",
            _describe_keys(citation),
        )
        return None

    # No ``content`` here, deliberately. The generated span is not a field of a
    # citation in either SDK: TypeScript puts it on ``CitationsDelta`` and
    # Python on ``CitationsContentBlock``, which is the assembled block rather
    # than anything the streaming path yields. Reading it off the citation
    # would be a branch that can never fire. The TypeScript adapter takes it
    # from the delta, where its SDK does supply it, so ``content`` reaches a
    # TypeScript client and not a Python one. See the README.
    # Keys captured before the offset joins them, so the log names the fields
    # the provider sent, which is what the TypeScript sibling reports too.
    described = _describe_keys(entry)
    entry["textOffset"] = text_offset

    encodable = _json_round_trip(entry)
    if encodable is None:
        logger.warning("Dropping unserializable citation (keys=%s)", described)
    return encodable


def copy_metadata(metadata: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """An independent copy of a citation metadata object.

    The event on the wire and the assistant message retained in the snapshot
    list need separate copies. The retained message is re-emitted in every
    later snapshot of the run, so a consumer mutating the list it received on
    ``TEXT_MESSAGE_END`` would otherwise corrupt every snapshot after it.

    Every value here has already passed :func:`normalize_citation`'s strict
    round trip, so this one cannot fail on content the module produced.
    """
    if metadata is None:
        return None
    copied = _json_round_trip(metadata)
    if copied is None:
        logger.warning("Dropping a citation list that no longer encodes")
    return copied


class CitationAccumulator:
    """Collects the citations of one assistant message.

    The accumulator also owns the running text offset. It deliberately does not
    read the adapter's ``accumulated_text``: that variable is reset only when
    message snapshots are being emitted, so an offset derived from it would
    keep counting across messages whenever snapshots are off.

    A message's citations are published as a complete list every time, because
    metadata merging replaces a key's value rather than appending to it. So
    each publish carries every citation seen so far for the open message, and a
    client always holds a whole prefix rather than a fragment.
    """

    def __init__(self) -> None:
        self._items: List[Dict[str, Any]] = []
        self._unpublished = False
        self._offset = 0

    def advance(self, delta: str) -> None:
        """Record text emitted for the open message.

        Counted in UTF-16 code units, not Python characters. The number is an
        index into the message text a client holds, and every client that will
        slice with it is a browser, where string indices are UTF-16 units. The
        TypeScript adapter gets the same number for free from
        ``String.prototype.length``; matching it here is what stops the two
        bridges disagreeing on any text containing an emoji.

        Counted per character rather than by encoding the string, because a
        lone surrogate is representable in a Python ``str`` and would make
        ``encode`` raise from the text path of every run, cited or not.
        """
        if not isinstance(delta, str):
            delta = str(delta)
        self._offset += sum(2 if ord(char) > 0xFFFF else 1 for char in delta)

    def add(self, citation: Any) -> None:
        """Record a citation against the text emitted for this message so far."""
        entry = normalize_citation(citation, self._offset)
        if entry is None:
            return
        self._items.append(entry)
        self._unpublished = True

    def __len__(self) -> int:
        return len(self._items)

    def pending(self) -> Optional[Dict[str, Any]]:
        """Metadata to attach mid-stream, or ``None`` if nothing is new.

        Returning ``None`` once published is what stops every remaining text
        delta of the message from re-sending an unchanged list.
        """
        if not self._unpublished:
            return None
        self._unpublished = False
        return self.metadata()

    def metadata(self) -> Optional[Dict[str, Any]]:
        """An independent copy of every citation collected so far, or ``None``.

        A fresh copy each call, so a consumer holding an earlier publish cannot
        see a later one mutate underneath it.
        """
        if not self._items:
            return None
        copied = _json_round_trip(self._items)
        if copied is None:
            logger.warning(
                "Dropping %d citation(s) that no longer encode", len(self._items)
            )
            return None
        return {CITATIONS_METADATA_KEY: copied}

    def take(self) -> Optional[Dict[str, Any]]:
        """Metadata for the closing message, resetting for the next one.

        Both the ``TEXT_MESSAGE_END`` event and the assistant message inside
        the following ``MESSAGES_SNAPSHOT`` need this value, and they need
        separate copies of it: see :func:`copy_metadata`.

        Callers drain this at every message boundary, including boundaries
        where no message was open, so citations cannot survive into the next
        message. See :func:`discard_orphans`.
        """
        metadata = self.metadata()
        self._items = []
        self._unpublished = False
        self._offset = 0
        return metadata


def discard_orphans(citations: CitationAccumulator, context: str) -> None:
    """Drop citations collected while no assistant message was open.

    Reached when a turn produces citations and no text. There is no message for
    them to annotate, and carrying them forward would attach one message's
    sources to the next one at a meaningless offset, so they are dropped. The
    warning exists because a silent drop here is indistinguishable from the
    model never citing anything.

    Always drains, even when there is nothing to drop, so the offset resets at
    every message boundary rather than only at the ones that had citations.
    """
    dropped = len(citations)
    citations.take()
    if dropped == 0:
        return
    logger.warning(
        "Dropping %d citation(s) that arrived with no open assistant message (%s)",
        dropped,
        context,
    )
