"""FastAPI endpoint utilities for AWS Strands integration."""

import asyncio
import json
from typing import Any, Callable, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunStartedEvent,
)
from ag_ui.encoder import AGUI_MEDIA_TYPE, EventEncoder

from .agent import StrandsAgent


async def _require_json_content_type(request: Request) -> None:
    """Reject requests whose media type cannot carry JSON."""
    content_type = request.headers.get("content-type")
    media_type = content_type.split(";", 1)[0].strip().lower() if content_type else ""
    is_json = media_type == "application/json"
    is_structured_json = media_type.startswith("application/") and media_type.endswith(
        "+json"
    )

    if not (is_json or is_structured_json):
        raise HTTPException(
            status_code=415,
            detail="Content-Type must be application/json or application/*+json",
        )


async def _parse_run_agent_input(request: Request) -> RunAgentInput:
    """Parse and validate the request body after route dependencies run."""
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise RequestValidationError(
            [
                {
                    "type": "json_invalid",
                    "loc": ("body", exc.pos),
                    "msg": "JSON decode error",
                    "input": {},
                    "ctx": {"error": exc.msg},
                }
            ],
            body=exc.doc,
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="There was an error parsing the body",
        ) from exc

    try:
        return RunAgentInput.model_validate(body)
    except ValidationError as exc:
        errors = []
        for error in exc.errors():
            request_error = dict(error)
            request_error["loc"] = ("body", *error["loc"])
            errors.append(request_error)
        raise RequestValidationError(errors, body=body) from exc


SSE_MEDIA_TYPE = "text/event-stream"


def _client_explicitly_requests_protobuf(accept: str | None) -> bool:
    """True only when the Accept header asks for protobuf outright.

    SSE is the protocol's default transport, so protobuf is opt-in: a
    wildcard Accept, an absent one, or `q=0` against the protobuf type all
    resolve to SSE.

    The guard matters even though the `EventEncoder` shipped with
    `ag-ui-protocol` ignores its `accept` argument and always encodes SSE,
    which makes the choice invisible today. The TypeScript `EventEncoder`
    does negotiate, offering protobuf as the only candidate and asking
    whether the header accepts it, which `*/*` does. Forwarding the raw
    header there would hand binary frames to every client that accepts
    anything, so its endpoint carries this same wildcard guard. Python
    keeps it so it does not acquire that behaviour the moment its own
    encoder gains protobuf.

    An unquoted `q=0` resolves to SSE on both adapters, at different
    layers: here in the guard, and there inside the encoder. A quoted
    `q="0"` still diverges, and is tracked as follow-up.
    """
    if not accept:
        return False
    for piece in accept.split(","):
        params = piece.split(";")
        if params[0].strip().lower() != AGUI_MEDIA_TYPE:
            continue
        if _quality(params[1:]) > 0:
            return True
    return False


def _quality(params: list[str]) -> float:
    """The q-value carried by ``params``, one Accept entry's parameters.

    `q=0` means the client refuses that entry.

    A q that is absent, unparseable, or outside the 0 to 1 range RFC 9110
    defines is treated as unstated, so only a well-formed `q=0` refuses.
    """
    for param in params:
        name, _, value = param.partition("=")
        if name.strip().lower() != "q":
            continue
        try:
            quality = float(value.strip())
        except ValueError:
            return 1.0
        return quality if 0 <= quality <= 1 else 1.0
    return 1.0


def _describe(error: BaseException) -> str:
    """Render an exception for the wire, tolerating a throwing ``__str__``."""
    try:
        return str(error)
    except Exception:
        return type(error).__name__


async def _settle_and_close(iterator, step) -> None:
    """Close an agent left running after its consumer was cancelled.

    Runs detached from the cancelled scope, so the agent's own teardown can
    await without being cut short.

    The in-flight step has to settle before the close: closing an async
    generator while another task sits inside `__anext__` is an error, not
    merely a race. It also has to be cancelled to settle at all, because a
    step waiting on something that never arrives, a model call that hangs,
    would otherwise hold the agent open for as long as it stayed blocked.

    Cancelling it here rather than letting the request's cancellation reach it
    is the whole point: this task is not itself being cancelled, so the
    CancelledError lands once and the agent's teardown can await afterwards.
    """
    if not step.done():
        step.cancel()
    try:
        await step
    except BaseException:
        pass
    closer = getattr(iterator, "aclose", None)
    if closer is not None:
        try:
            await closer()
        except BaseException:
            pass


def _binary_encoder(encoder: EventEncoder):
    """The encoder's binary entry point, or None if it has no such path.

    `EventEncoder` may negotiate a protobuf content type without being able
    to produce protobuf bytes. Serving text under that content type would
    make the header a lie, so the endpoint checks for the entry point before
    honouring the negotiation.
    """
    encode_binary = getattr(encoder, "encode_binary", None)
    return encode_binary if callable(encode_binary) else None


def _negotiated_encoder(accept_header: str | None) -> EventEncoder:
    """Build the encoder for this request, refusing to over-promise.

    A protobuf content type is honoured only when the encoder can actually
    encode protobuf. The `ag-ui-protocol` encoder currently cannot, so a
    client naming protobuf is served SSE and told so, rather than being sent
    text labelled as binary.
    """
    if not _client_explicitly_requests_protobuf(accept_header):
        return EventEncoder(accept=SSE_MEDIA_TYPE)
    encoder = EventEncoder(accept=accept_header)
    if encoder.get_content_type() == AGUI_MEDIA_TYPE and _binary_encoder(encoder) is None:
        return EventEncoder(accept=SSE_MEDIA_TYPE)
    return encoder


def _encoded_or_none(encoder: EventEncoder, event) -> str | bytes | None:
    """Encode an event, or return None when the encoder itself fails.

    Used for the frames that report a failure. Those cannot raise their way
    out of the generator: that aborts the response mid-body and the client
    is left with the truncated stream the frame existed to explain.
    """
    try:
        return (_binary_encoder(encoder) or encoder.encode)(event)
    except Exception:
        return None

def add_strands_fastapi_endpoint(
    app: FastAPI,
    agent: StrandsAgent,
    path: str,
    *,
    auth: Optional[Callable[..., Any]] = None,
    **kwargs: Any,
) -> None:
    """Add a Strands agent endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        agent: The StrandsAgent instance
        path: Path for the agent endpoint
        auth: Optional FastAPI dependency callable used to authenticate requests.
            It should raise ``fastapi.HTTPException`` to reject a request. The
            endpoint is unauthenticated when this is ``None``. Authentication
            runs before the request body is parsed and validated.
        **kwargs: Forwarded to ``app.post`` (``tags``, ``dependencies``, ...).
            Any ``dependencies`` given here run after the ones this helper
            installs, rather than replacing them.
    """

    dependencies = []
    if auth is not None:
        dependencies.append(Depends(auth))
    dependencies.append(Depends(_require_json_content_type))
    dependencies.extend(kwargs.pop("dependencies", []))

    kwargs.setdefault(
        "openapi_extra",
        {
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": RunAgentInput.model_json_schema(by_alias=True)
                    }
                },
            }
        },
    )

    @app.post(path, dependencies=dependencies, **kwargs)
    async def strands_endpoint(request: Request):
        """AWS Strands agent endpoint."""
        input_data = await _parse_run_agent_input(request)
        # A client may send Accept as several field lines. `get` returns only
        # the first, which would hide a protobuf entry on a later one; Node
        # joins them before the Express peer ever sees the header.
        accept_header = ", ".join(request.headers.getlist("accept")) or None
        encoder = _negotiated_encoder(accept_header)
        encode = _binary_encoder(encoder) or encoder.encode

        async def event_generator():
            run_is_open = False
            saw_terminal_frame = False
            emitted_any = False
            failure: tuple[str, str] | None = None

            try:
                stream = agent.run(input_data)
                iterator = stream.__aiter__()
            except Exception as e:
                # Headers are already committed, so a failure to even start
                # the agent has to be reported in the body like any other.
                iterator = None
                failure = ("STRANDS_ERROR", _describe(e))

            try:
                while iterator is not None:
                    # Each step runs in its own task, awaited through a
                    # shield, so a client disconnect cancels this handler
                    # without cancelling the agent. Awaited directly, the
                    # cancellation lands inside the agent, its teardown starts,
                    # and the first `await` in that teardown is cancelled too,
                    # which leaves whatever it releases after that point
                    # released by nobody. anyio's cancel scope re-delivers on
                    # every await, so there is no recovering from it after the
                    # fact: the agent has to be outside the scope to begin with.
                    #
                    # Costs one task per event. Cheap next to encoding a frame
                    # and writing it to a socket.
                    step = asyncio.ensure_future(iterator.__anext__())
                    try:
                        event = await asyncio.shield(step)
                    except StopAsyncIteration:
                        break
                    except asyncio.CancelledError:
                        # Hand the agent to a task outside this scope so its
                        # teardown can finish, then let the cancellation go.
                        asyncio.ensure_future(_settle_and_close(iterator, step))
                        raise
                    except Exception as e:
                        # The agent converts its own failures into RUN_ERROR.
                        # Anything reaching here escaped that, and without this net
                        # the client would see a stream that simply stops. Mirrors
                        # the TypeScript adapter's STRANDS_ERROR fallback.
                        failure = ("STRANDS_ERROR", _describe(e))
                        break

                    try:
                        chunk = encode(event)
                    except Exception as e:
                        failure = ("ENCODING_ERROR", f"Encoding error: {_describe(e)}")
                        break

                    event_type = getattr(event, "type", None)
                    if event_type == EventType.RUN_STARTED:
                        # A stream may carry several sequential runs, so each
                        # RUN_STARTED reopens: an earlier run's terminal frame must
                        # not suppress this run's failure.
                        run_is_open = True
                    elif event_type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
                        run_is_open = False
                        saw_terminal_frame = True

                    # Outside the handlers above on purpose. A failure to write is
                    # the consumer's, not the agent's, so it must propagate rather
                    # than be relabelled and answered with another write.
                    emitted_any = True
                    yield chunk
            finally:
                # Close the iterator, not the iterable it came from: an
                # iterable whose __aiter__ builds a generator would otherwise
                # leave the agent open. In a `finally`, as the TypeScript peer
                # does, so it runs on every way out including the consumer
                # closing this generator early. Awaiting here is safe even
                # while this generator is itself being closed; only yielding
                # again during teardown would raise.
                #
                # The disconnect path does not arrive here with work left to
                # do: it is handed to `_settle_and_close` above, which owns the
                # close from outside the cancelled scope.
                closer = getattr(iterator, "aclose", None)
                if closer is not None:
                    try:
                        await closer()
                    except Exception:
                        # A throwing agent cleanup must not abort the body
                        # before the frame explaining the failure has been
                        # written. On a run that otherwise succeeded this does
                        # swallow the teardown error; the endpoint has no
                        # logger, so there is nowhere to put it that the client
                        # should see.
                        pass

            if failure is None:
                return
            if saw_terminal_frame and not run_is_open:
                # The stream already reported a run's terminal frame and has
                # not opened another. Appending RUN_ERROR would contradict it.
                return

            code, message = failure
            # Encode in the order the frames go out, and encode both before
            # emitting either. Encoding out of order would corrupt a stateful
            # encoder, and emitting the opening frame first would leave a run
            # open with no terminal frame if the error frame proved unencodable.
            opening = None
            if not run_is_open and not emitted_any:
                # RUN_ERROR belongs to a run, so a failure that beat the
                # agent's own RUN_STARTED needs one before it. Only while the
                # stream is still empty. An agent that streamed content
                # without opening a run has already broken the contract, and
                # a RUN_ERROR with no run is the smaller of the two lies
                # available: the alternative puts a RUN_STARTED after frames
                # it claims to precede.
                opening = _encoded_or_none(
                    encoder,
                    RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    ),
                )
                if opening is None:
                    return

            error_frame = _encoded_or_none(
                encoder,
                RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code),
            )
            if error_frame is None:
                return

            if opening is not None:
                yield opening
            yield error_frame

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
            # Keeps intermediaries and the browser from caching or replaying
            # a run's frames. It does not govern buffering; a proxy that
            # buffers SSE needs its own directive. The TypeScript peer sets
            # the same header.
            headers={"Cache-Control": "no-cache"},
        )


def add_ping(app: FastAPI, path: str, **kwargs: Any) -> None:
    """Add a ping endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        path: Path for the ping endpoint
        **kwargs: Forwarded to ``app.get`` (``dependencies``, ``tags``, ...)
    """

    @app.get(path, **kwargs)
    async def ping():
        """Ping endpoint."""
        return {"status": "healthy"}
