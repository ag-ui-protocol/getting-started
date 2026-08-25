"""FastAPI endpoint utilities for AWS Strands integration."""

import json
from typing import Any, Callable, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder

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


def add_strands_fastapi_endpoint(
    app: FastAPI,
    agent: StrandsAgent,
    path: str,
    *,
    auth: Optional[Callable[..., Any]] = None,
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
    """

    dependencies = []
    if auth is not None:
        dependencies.append(Depends(auth))
    dependencies.append(Depends(_require_json_content_type))

    @app.post(
        path,
        dependencies=dependencies,
        openapi_extra={
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
    async def strands_endpoint(request: Request):
        """AWS Strands agent endpoint."""
        input_data = await _parse_run_agent_input(request)
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)
        
        async def event_generator():
            async for event in agent.run(input_data):
                try:
                    yield encoder.encode(event)
                except Exception as e:
                    from ag_ui.core import RunErrorEvent, EventType
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Encoding error: {str(e)}",
                        code="ENCODING_ERROR"
                    )
                    yield encoder.encode(error_event)
                    break
        
        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        )

def add_ping(app: FastAPI, path: str) -> None:
    """Add a ping endpoint to FastAPI app.
    
    Args:
        app: FastAPI application instance
        path: Path for the ping endpoint (default: "/ping")
    """
    
    @app.get(path)
    async def ping():
        """Ping endpoint."""
        return {"status": "healthy"}
