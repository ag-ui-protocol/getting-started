#!/usr/bin/env python
"""Complete setup example for ADK middleware with AG-UI."""

import logging

import asyncio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Set up basic logging format
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Configure component-specific logging levels using standard Python logging
# Can be overridden with PYTHONPATH or programmatically
logging.getLogger('adk_agent').setLevel(logging.WARNING)
logging.getLogger('event_translator').setLevel(logging.WARNING)
logging.getLogger('endpoint').setLevel(logging.WARNING)
logging.getLogger('session_manager').setLevel(logging.WARNING)
logging.getLogger('agent_registry').setLevel(logging.WARNING)

# from adk_agent import ADKAgent
# from agent_registry import AgentRegistry
# from endpoint import add_adk_fastapi_endpoint
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
# Import Google ADK components
from google.adk.agents import Agent
from google.adk import tools as adk_tools
import os

# Compatibility shim for PreloadMemoryTool (renamed in newer ADK versions)
try:
    PreloadMemoryTool = adk_tools.preload_memory.PreloadMemoryTool
except AttributeError:
    PreloadMemoryTool = adk_tools.preload_memory_tool.PreloadMemoryTool

# Ensure session_manager logger is set to DEBUG after import
logging.getLogger('ag_ui_adk.session_manager').setLevel(logging.DEBUG)
# Also explicitly set adk_agent logger to DEBUG
logging.getLogger('ag_ui_adk.adk_agent').setLevel(logging.DEBUG)


async def setup_and_run():
    """Complete setup and run the server."""

    # Step 1: Configure Google ADK authentication
    # Google ADK uses environment variables for authentication:
    # export GOOGLE_API_KEY="your-api-key-here"
    #
    # Or use Application Default Credentials (ADC):
    # gcloud auth application-default login

    # The API key will be automatically picked up from the environment


    # Step 2: Create shared memory service
    print("🧠 Creating shared memory service...")
    from google.adk.memory import InMemoryMemoryService
    shared_memory_service = InMemoryMemoryService()

    # Step 3: Create your ADK agent(s)
    print("🤖 Creating ADK agents...")

    # Create a versatile assistant
    assistant = Agent(
        name="ag_ui_assistant",
        model="gemini-3.5-flash",
        instruction="""You are a helpful AI assistant integrated with AG-UI protocol.

        Your capabilities:
        - Answer questions accurately and concisely
        - Help with coding and technical topics
        - Provide step-by-step explanations
        - Admit when you don't know something

        Always be friendly and professional.""",
        tools=[PreloadMemoryTool()]
    )

    # Try to import haiku generator agent
    print("🎋 Attempting to import haiku generator agent...")
    haiku_generator_agent = None
    try:
        from tool_based_generative_ui.agent import haiku_generator_agent
        print(f"   ✅ Successfully imported haiku_generator_agent")
        print(f"   Type: {type(haiku_generator_agent)}")
        print(f"   Name: {getattr(haiku_generator_agent, 'name', 'NO NAME')}")
        print(f"   ✅ Available for use")
    except Exception as e:
        print(f"   ❌ Failed to import haiku_generator_agent: {e}")

    print(f"\n📋 Available agents:")
    print(f"   - assistant: {assistant.name}")
    if haiku_generator_agent:
        print(f"   - haiku_generator: {haiku_generator_agent.name}")


    # Step 4: Configure ADK middleware
    print("⚙️ Configuring ADK middleware...")

    # Option A: Static app name and user ID (simple testing)
    # adk_agent = ADKAgent(
    #     app_name="demo_app",
    #     user_id="demo_user",
    #     use_in_memory_services=True
    # )

    # Option B: Dynamic extraction from context (recommended)
    def extract_user_id(input_data):
        """Extract user ID from context."""
        for ctx in input_data.context:
            if ctx.description == "user":
                return ctx.value
        return "test_user"  # Static user ID for memory testing

    def extract_app_name(input_data):
        """Extract app name from context."""
        for ctx in input_data.context:
            if ctx.description == "app":
                return ctx.value
        return "default_app"

    # Create ADKAgent instances for different agents
    assistant_adk_agent = ADKAgent(
        adk_agent=assistant,
        app_name_extractor=extract_app_name,
        user_id_extractor=extract_user_id,
        use_in_memory_services=True,
        memory_service=shared_memory_service,  # Use the same memory service as the ADK agent
        # Defaults: 1200s timeout (20 min), 300s cleanup (5 min)
    )

    haiku_adk_agent = None
    if haiku_generator_agent:
        haiku_adk_agent = ADKAgent(
            adk_agent=haiku_generator_agent,
            app_name_extractor=extract_app_name,
            user_id_extractor=extract_user_id,
            use_in_memory_services=True,
            memory_service=shared_memory_service,
        )

    # Step 5: Create FastAPI app
    print("🌐 Creating FastAPI app...")
    app = FastAPI(
        title="ADK-AG-UI Integration Server",
        description="Google ADK agents exposed via AG-UI protocol"
    )

    # Add CORS for browser clients
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:5173"],  # Add your client URLs
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


    # Step 6: Add endpoints
    # Each endpoint uses its specific ADKAgent instance
    add_adk_fastapi_endpoint(app, assistant_adk_agent, path="/chat")

    # Add haiku generator endpoint if available
    if haiku_adk_agent:
        add_adk_fastapi_endpoint(app, haiku_adk_agent, path="/adk-tool-based-generative-ui")
        print("   ✅ Added endpoint: /adk-tool-based-generative-ui")
    else:
        print("   ❌ Skipped haiku endpoint - agent not available")

    # Agent-specific endpoints (optional) - each would use its own ADKAgent instance
    # assistant_adk_agent = ADKAgent(adk_agent=assistant, ...)
    # add_adk_fastapi_endpoint(app, assistant_adk_agent, path="/agents/assistant")
    # code_helper_adk_agent = ADKAgent(adk_agent=code_helper, ...)
    # add_adk_fastapi_endpoint(app, code_helper_adk_agent, path="/agents/code-helper")

    @app.get("/")
    async def root():
        available_agents = ["assistant"]
        endpoints = {"chat": "/chat", "docs": "/docs", "health": "/health"}
        if haiku_generator_agent:
            available_agents.append("haiku-generator")
            endpoints["adk-tool-based-generative-ui"] = "/adk-tool-based-generative-ui"

        return {
            "service": "ADK-AG-UI Integration",
            "version": "0.1.0",
            "agents": {
                "default": "assistant",
                "available": available_agents
            },
            "endpoints": endpoints
        }

    @app.get("/health")
    async def health():
        agent_count = 1  # assistant
        if haiku_generator_agent:
            agent_count += 1
        return {
            "status": "healthy",
            "agents_available": agent_count,
            "default_agent": "assistant"
        }

    @app.get("/agents")
    async def list_agents():
        """List available agents."""
        available_agents = ["assistant"]
        if haiku_generator_agent:
            available_agents.append("haiku-generator")
        return {
            "agents": available_agents,
            "default": "assistant"
        }


    # Step 7: Run the server
    print("\n✅ Setup complete! Starting server...\n")
    print("🔗 Chat endpoint: http://localhost:8000/chat")
    print("📚 API documentation: http://localhost:8000/docs")
    print("🏥 Health check: http://localhost:8000/health")
    print("\n🔧 Logging Control:")
    print("   # Set logging level for specific components:")
    print("   logging.getLogger('event_translator').setLevel(logging.DEBUG)")
    print("   logging.getLogger('endpoint').setLevel(logging.DEBUG)")
    print("   logging.getLogger('session_manager').setLevel(logging.DEBUG)")
    print("\n🧪 Test with curl:")
    print('curl -X POST http://localhost:8000/chat \\')
    print('  -H "Content-Type: application/json" \\')
    print('  -H "Accept: text/event-stream" \\')
    print('  -d \'{')
    print('    "thread_id": "test-123",')
    print('    "run_id": "run-456",')
    print('    "messages": [{"role": "user", "content": "Hello! What can you do?"}],')
    print('    "context": [')
    print('      {"description": "user", "value": "john_doe"},')
    print('      {"description": "app", "value": "my_app_v1"}')
    print('    ]')
    print('  }\'')

    # Run with uvicorn
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    # Check for API key
    if not os.getenv("GOOGLE_API_KEY"):
        print("⚠️  Warning: GOOGLE_API_KEY environment variable not set!")
        print("   Set it with: export GOOGLE_API_KEY='your-key-here'")
        print("   Get a key from: https://makersuite.google.com/app/apikey")
        print()

    # Run the async setup
    asyncio.run(setup_and_run())