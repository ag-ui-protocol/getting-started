#!/usr/bin/env python
"""Test server for ADK middleware with AG-UI client."""

import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / "src"))

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

# Import your ADK agent - adjust based on what you have
from google.adk.agents import Agent

# Create FastAPI app
app = FastAPI(title="ADK Middleware Test Server")

# Add CORS middleware for browser-based AG-UI clients.
# Origins come from CORS_ALLOW_ORIGINS (comma-separated) and default to the "*"
# wildcard for local testing. Credentials are only enabled for explicit,
# non-wildcard origins — a wildcard can never be combined with
# allow_credentials=True (any site could then read authenticated responses).
_origins = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
cors_origins = _origins or ["*"]  # Configure appropriately for production
is_wildcard = "*" in cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=bool(_origins) and not is_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Set up agent registry
registry = AgentRegistry.get_instance()

# Create a simple test agent
test_agent = Agent(
    name="test_assistant",
    instruction="You are a helpful AI assistant for testing the ADK middleware."
)

# Register the agent
registry.register_agent("test-agent", test_agent)
registry.set_default_agent(test_agent)

# Create ADK middleware instance
adk_agent = ADKAgent(
    app_name="test_app",
    user_id="test_user",  # Or use user_id_extractor for dynamic user resolution
    use_in_memory_services=True,
)

# Add the chat endpoint
add_adk_fastapi_endpoint(app, adk_agent, path="/chat")

@app.get("/")
async def root():
    return {
        "service": "ADK Middleware",
        "status": "ready",
        "endpoints": {
            "chat": "/chat",
            "docs": "/docs"
        }
    }

@app.get("/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    print("🚀 Starting ADK Middleware Test Server")
    print("📍 Chat endpoint: http://localhost:8000/chat")
    print("📚 API docs: http://localhost:8000/docs")
    print("\nTo test with curl:")
    print('curl -X POST http://localhost:8000/chat \\')
    print('  -H "Content-Type: application/json" \\')
    print('  -H "Accept: text/event-stream" \\')
    print('  -d \'{"thread_id": "test-thread", "run_id": "test-run", "messages": [{"role": "user", "content": "Hello!"}]}\'')

    uvicorn.run(app, host="0.0.0.0", port=8000)