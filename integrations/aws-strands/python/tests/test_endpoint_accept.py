"""Content negotiation on the Strands FastAPI endpoint.

SSE is the protocol's default transport. Protobuf is opt-in: a client only
gets binary frames when it names the protobuf media type outright. A
wildcard `Accept`, a missing `Accept`, or an unrelated one all resolve to
SSE.

The `EventEncoder` shipped by `ag-ui-protocol` currently ignores its
`accept` argument and always encodes SSE, so the endpoint's negotiation
decision is invisible against the real encoder. The tests that pin the
decision itself therefore install a `NegotiatingEncoder` double that
implements the one part of negotiation that makes an unguarded
pass-through observable: treating a wildcard as accepting protobuf, as the
TypeScript `EventEncoder` does. It deliberately does not implement q
handling, because the guard under test resolves `q=0` before any encoder
sees the header.

The double encodes real bytes on its protobuf path. A double that named
protobuf while emitting SSE text would let the endpoint advertise a content
type it cannot produce and still pass, which is the state
`TextOnlyNegotiatingEncoder` now pins as a fallback to SSE instead.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui.encoder import AGUI_MEDIA_TYPE
from ag_ui_strands import endpoint as endpoint_module
from ag_ui_strands.endpoint import SSE_MEDIA_TYPE, add_strands_fastapi_endpoint

from tests.endpoint_helpers import FakeAgent, valid_run_input


class TextOnlyNegotiatingEncoder:
    """Negotiates protobuf but has no binary encode path.

    This is the shape of the encoder that actually ships: it can name a
    protobuf content type without being able to produce protobuf.
    """

    def __init__(self, accept: str | None = None) -> None:
        self._accept = accept or ""
        self._protobuf = any(
            piece.split(";")[0].strip().lower() in (AGUI_MEDIA_TYPE, "*/*")
            for piece in self._accept.split(",")
        )

    def get_content_type(self) -> str:
        return AGUI_MEDIA_TYPE if self._protobuf else SSE_MEDIA_TYPE

    def encode(self, event) -> str:
        return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


class NegotiatingEncoder(TextOnlyNegotiatingEncoder):
    """A negotiating encoder that can also produce binary frames."""

    def encode_binary(self, event) -> bytes:
        return b"\x00" + event.model_dump_json(by_alias=True, exclude_none=True).encode()


def _client(agent: FakeAgent | None = None) -> TestClient:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent or FakeAgent(), "/")
    return TestClient(app)


def _post(client: TestClient, accept: str | None) -> object:
    """POST with the given Accept, or with none at all.

    httpx sets `Accept: */*` unless it is removed from the client defaults,
    so passing None here has to delete it rather than just omit it, or the
    absent-header branch is never reached.
    """
    if accept is None:
        del client.headers["accept"]
        return client.post("/", json=valid_run_input())
    return client.post("/", json=valid_run_input(), headers={"Accept": accept})


def _content_type(response) -> str:
    """The media type alone, with any `; charset=...` parameter stripped."""
    return response.headers["content-type"].split(";")[0].strip()


@pytest.fixture
def negotiating_encoder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(endpoint_module, "EventEncoder", NegotiatingEncoder)


@pytest.fixture
def text_only_encoder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(endpoint_module, "EventEncoder", TextOnlyNegotiatingEncoder)


@pytest.mark.parametrize(
    "accept",
    [
        pytest.param("*/*", id="wildcard"),
        pytest.param(None, id="absent"),
        pytest.param(SSE_MEDIA_TYPE, id="sse"),
        pytest.param("application/json", id="unrelated"),
        pytest.param("text/*", id="type-wildcard"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=0", id="protobuf-refused"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=0.0", id="protobuf-refused-decimal"),
        pytest.param(
            f"{AGUI_MEDIA_TYPE};q=0, {SSE_MEDIA_TYPE}", id="protobuf-refused-sse-offered"
        ),
    ],
)
def test_serves_sse_unless_protobuf_is_named(negotiating_encoder, accept) -> None:
    response = _post(_client(), accept)

    assert response.status_code == 200
    assert _content_type(response) == SSE_MEDIA_TYPE


@pytest.mark.parametrize(
    "accept",
    [
        pytest.param(AGUI_MEDIA_TYPE, id="alone"),
        pytest.param(f"{AGUI_MEDIA_TYPE}, {SSE_MEDIA_TYPE};q=0.9", id="ranked-first"),
        pytest.param(f"{SSE_MEDIA_TYPE};q=0.9, {AGUI_MEDIA_TYPE}", id="ranked-second"),
        pytest.param(f"{AGUI_MEDIA_TYPE}; charset=utf-8", id="with-parameter"),
        pytest.param(AGUI_MEDIA_TYPE.upper(), id="uppercase"),
        pytest.param(f"  {AGUI_MEDIA_TYPE}  ", id="padded"),
    ],
)
def test_serves_protobuf_when_the_client_names_it(negotiating_encoder, accept) -> None:
    response = _client().post("/", json=valid_run_input(), headers={"Accept": accept})

    assert response.status_code == 200
    assert _content_type(response) == AGUI_MEDIA_TYPE


@pytest.mark.parametrize(
    "accept",
    [
        pytest.param(f"{AGUI_MEDIA_TYPE};q=0.1", id="low-but-acceptable"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=1", id="explicit-full-quality"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=not-a-number", id="unparseable-q"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=-1", id="negative-q"),
        pytest.param(f"{AGUI_MEDIA_TYPE};q=5", id="above-range-q"),
    ],
)
def test_any_nonzero_quality_still_selects_protobuf(negotiating_encoder, accept) -> None:
    """Only a well-formed `q=0` refuses.

    A low preference is still a request, and a q outside the 0 to 1 range
    RFC 9110 defines is malformed, so it is read as unstated rather than as
    a refusal. Without that clamp `q=-1` would silently mean the opposite of
    `q=5`.
    """
    response = _client().post("/", json=valid_run_input(), headers={"Accept": accept})

    assert _content_type(response) == AGUI_MEDIA_TYPE


@pytest.mark.parametrize(
    "accept",
    [None, "*/*", SSE_MEDIA_TYPE, AGUI_MEDIA_TYPE, "application/json"],
)
def test_real_encoder_always_streams_sse(accept) -> None:
    """Against the shipped encoder every Accept resolves to SSE.

    The installed `EventEncoder` has no protobuf implementation, so the
    endpoint cannot serve binary today whatever the client asks for. This
    pins the behaviour clients actually see, so that the day the encoder
    gains protobuf the change is visible here rather than silent.
    """
    response = _post(_client(), accept)

    assert response.status_code == 200
    assert _content_type(response) == SSE_MEDIA_TYPE
    assert response.text.startswith("data: ")


def test_protobuf_named_on_a_later_accept_line_is_still_found(
    negotiating_encoder,
) -> None:
    """Accept may arrive as several field lines; all of them count."""
    app = FastAPI()
    add_strands_fastapi_endpoint(app, FakeAgent(), "/")
    with TestClient(app) as client:
        response = client.post(
            "/",
            json=valid_run_input(),
            headers=[
                ("accept", SSE_MEDIA_TYPE),
                ("accept", AGUI_MEDIA_TYPE),
            ],
        )

    assert _content_type(response) == AGUI_MEDIA_TYPE


@pytest.mark.parametrize(
    "accept",
    [
        pytest.param(AGUI_MEDIA_TYPE, id="alone"),
        pytest.param(f"{AGUI_MEDIA_TYPE}, {SSE_MEDIA_TYPE};q=0.9", id="ranked-first"),
    ],
)
def test_protobuf_is_refused_when_the_encoder_cannot_produce_it(
    text_only_encoder, accept
) -> None:
    """Serving text under a protobuf content type would make the header a lie.

    This is the shipped encoder's shape, so it is the path real clients take
    today: naming protobuf gets SSE, and the response says SSE.
    """
    response = _client().post("/", json=valid_run_input(), headers={"Accept": accept})

    assert response.status_code == 200
    assert _content_type(response) == SSE_MEDIA_TYPE
    assert response.text.startswith("data: ")


def test_protobuf_frames_are_binary_when_the_encoder_can_produce_them(
    negotiating_encoder,
) -> None:
    """The negotiated content type has to match what the body actually carries."""
    response = _client().post(
        "/", json=valid_run_input(), headers={"Accept": AGUI_MEDIA_TYPE}
    )

    assert _content_type(response) == AGUI_MEDIA_TYPE
    assert response.content.startswith(b"\x00")
