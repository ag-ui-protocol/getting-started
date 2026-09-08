"""AG-UI Dojo server for the AWS Strands integration.

Simple server running all example agents.
"""
import os
import sys
import warnings
import uvicorn
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Add src directory to Python path to import ag_ui_strands
src_dir = Path(__file__).parent.parent.parent / "src"
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

# Load environment variables from examples/.env, which is where the README tells
# the operator to put them. One `parent` fewer than the api modules use, because
# this file sits one directory shallower than they do.
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Quieten OpenTelemetry warnings by default, before the api imports below,
# which is what has to happen for the setting to take effect at all.
#
# `setdefault` so an operator value from the environment or examples/.env
# survives this line. It does not survive the import that follows: most demo
# modules assign the same two variables outright, which is their bug to fix,
# not something this line can defend against.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "all")

# Import agent apps
from . import api
from .settings import (
    CORS_ORIGINS_VAR,
    DEMO_PATHS,
    WILDCARD,
    allow_credentials,
    app_attribute,
    cors_origins,
    mount_name,
    names_nothing,
    port_from_env,
)

# Enough to tell "this could match a request" from "this cannot", for the
# startup notice only. Not a validator: an entry it judges wrongly still goes
# to the middleware unchanged, so the worst it can do is word a warning badly.
def _could_match_a_request(origin: str) -> bool:
    return origin == WILDCARD or "://" in origin

# Create main app
app = FastAPI(title='AWS Strands - AG-UI Dojo')

# Add CORS. The mounted demos are given the same origins, because a demo left
# on the wildcard default would answer a disallowed origin with
# Access-Control-Allow-Origin: * and this middleware would then add
# Access-Control-Allow-Credentials: true on the way out.
_origins = cors_origins()

# Reported here rather than inside the settings helpers, which every demo calls
# too: one notice per server start, not one per demo.
#
# Only an unset or whitespace-only value opens the wildcard. A value that was
# written but says nothing usable refuses every origin instead, which is the
# recoverable direction, so it gets its own notice rather than being widened.
if names_nothing():
    warnings.warn(
        f"{CORS_ORIGINS_VAR} is unset, so every browser origin is allowed. Set it "
        "to the origins your frontend is served from before exposing this server.",
        stacklevel=1,
    )
elif not any(_could_match_a_request(origin) for origin in _origins):
    warnings.warn(
        f"{CORS_ORIGINS_VAR} is set to {os.getenv(CORS_ORIGINS_VAR)!r}, which names "
        "no origin a browser can send, so every cross-origin request will be "
        "refused, including from your own frontend.",
        stacklevel=1,
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=allow_credentials(_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount agents
for _path in DEMO_PATHS:
    app.mount(_path, getattr(api, app_attribute(_path)), mount_name(_path))

@app.get("/")
def root():
    return {
        "message": "AWS Strands - AG-UI Dojo",
        "endpoints": {mount_name(path): path for path in DEMO_PATHS},
    }

def main():
    """Start the server."""
    uvicorn.run(app, host="0.0.0.0", port=port_from_env())

__all__ = ["main", "app"]
