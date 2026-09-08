import os
import uvicorn
from fastapi import FastAPI
from dotenv import load_dotenv

load_dotenv()

from .routers.agentic_chat import agentic_chat_router
from .routers.agentic_chat_multimodal import agentic_chat_multimodal_router
from .routers.human_in_the_loop import human_in_the_loop_router
from .routers.agentic_generative_ui import agentic_generative_ui_router
from .routers.shared_state import shared_state_router
from .routers.backend_tool_rendering import backend_tool_rendering_router

app = FastAPI(title="AG-UI Llama-Index Endpoint")

app.include_router(agentic_chat_router, prefix="/agentic_chat")
app.include_router(agentic_chat_multimodal_router, prefix="/agentic_chat_multimodal")
app.include_router(human_in_the_loop_router, prefix="/human_in_the_loop")
app.include_router(agentic_generative_ui_router, prefix="/agentic_generative_ui")

app.include_router(shared_state_router, prefix="/shared_state")
app.include_router(backend_tool_rendering_router, prefix="/backend_tool_rendering")
def main():

    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "9000"))

    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main"]
