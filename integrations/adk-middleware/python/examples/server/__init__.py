"""Example usage of the ADK middleware with FastAPI.

This provides a FastAPI application that demonstrates how to use the
ADK middleware with various agent types. It includes examples for
each of the ADK middleware features:
- Agentic Chat Agent
- Tool Based Generative UI
- Human in the Loop
- Shared State
- Predictive State Updates
"""

from __future__ import annotations

from fastapi import FastAPI
import uvicorn
import os


from .api import (
    agentic_chat_app,
    agentic_chat_reasoning_app,
    agentic_generative_ui_app,
    tool_based_generative_ui_app,
    human_in_the_loop_app,
    shared_state_app,
    backend_tool_rendering_app,
    predictive_state_updates_app,
    a2ui_dynamic_schema_app,
    a2ui_fixed_schema_app,
    a2ui_recovery_app,
)

app = FastAPI(title='ADK Middleware Demo')

# Include routers instead of mounting apps to show routes in docs
app.include_router(agentic_chat_app.router, prefix='/chat', tags=['Agentic Chat'])
app.include_router(a2ui_dynamic_schema_app.router, prefix='/adk-a2ui-dynamic-schema', tags=['A2UI Dynamic Schema'])
app.include_router(a2ui_fixed_schema_app.router, prefix='/adk-a2ui-fixed-schema', tags=['A2UI Fixed Schema'])
app.include_router(a2ui_recovery_app.router, prefix='/adk-a2ui-recovery', tags=['A2UI Error Recovery'])
app.include_router(agentic_generative_ui_app.router, prefix='/adk-agentic-generative-ui', tags=['Agentic Generative UI'])
app.include_router(tool_based_generative_ui_app.router, prefix='/adk-tool-based-generative-ui', tags=['Tool Based Generative UI'])
app.include_router(human_in_the_loop_app.router, prefix='/adk-human-in-loop-agent', tags=['Human in the Loop'])
app.include_router(shared_state_app.router, prefix='/adk-shared-state-agent', tags=['Shared State'])
app.include_router(backend_tool_rendering_app.router, prefix='/backend_tool_rendering', tags=['Backend Tool Rendering'])
app.include_router(predictive_state_updates_app.router, prefix='/adk-predictive-state-agent', tags=['Predictive State Updates'])
app.include_router(agentic_chat_reasoning_app.router, prefix='/adk-reasoning-chat', tags=['Agentic Chat Reasoning'])


@app.get("/")
async def root():
    return {
        "message": "ADK Middleware is running!",
        "endpoints": {
            "chat": "/chat",
            "agentic_generative_ui": "/adk-agentic-generative-ui",
            "tool_based_generative_ui": "/adk-tool-based-generative-ui",
            "human_in_the_loop": "/adk-human-in-loop-agent",
            "shared_state": "/adk-shared-state-agent",
            "backend_tool_rendering": "/backend_tool_rendering",
            "predictive_state_updates": "/adk-predictive-state-agent",
            "agentic_chat_reasoning": "/adk-reasoning-chat",
            "a2ui_dynamic_schema": "/adk-a2ui-dynamic-schema",
            "a2ui_fixed_schema": "/adk-a2ui-fixed-schema",
            "a2ui_recovery": "/adk-a2ui-recovery",
            "docs": "/docs"
        }
    }


def main():
    """Main function to start the FastAPI server."""
    # Check for authentication credentials
    google_api_key = os.getenv("GOOGLE_API_KEY")
    google_app_creds = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

    if not google_api_key and not google_app_creds:
        print("⚠️  Warning: No Google authentication credentials found!")
        print()
        print("   Google ADK uses environment variables for authentication:")
        print("   - API Key:")
        print("     ```")
        print("     export GOOGLE_API_KEY='your-api-key-here'")
        print("     ```")
        print("     Get a key from: https://makersuite.google.com/app/apikey")
        print()
        print("   - Or use Application Default Credentials (ADC):")
        print("     ```")
        print("     gcloud auth application-default login")
        print("     export GOOGLE_APPLICATION_CREDENTIALS='path/to/service-account.json'")
        print("     ```")
        print("     See docs here: https://cloud.google.com/docs/authentication/application-default-credentials")
        print()
        print("   The credentials will be automatically picked up from the environment")
        print()

    port = int(os.getenv("PORT", "8000"))
    print("Starting ADK Middleware server...")
    print(f"Available endpoints:")
    print(f"  • Chat: http://localhost:{port}/chat")
    print(f"  • Agentic Generative UI: http://localhost:{port}/adk-agentic-generative-ui")
    print(f"  • Tool Based Generative UI: http://localhost:{port}/adk-tool-based-generative-ui")
    print(f"  • Human in the Loop: http://localhost:{port}/adk-human-in-loop-agent")
    print(f"  • Shared State: http://localhost:{port}/adk-shared-state-agent")
    print(f"  • Predictive State Updates: http://localhost:{port}/adk-predictive-state-agent")
    print(f"  • Agentic Chat Reasoning: http://localhost:{port}/adk-reasoning-chat")
    print(f"  • API docs: http://localhost:{port}/docs")
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
