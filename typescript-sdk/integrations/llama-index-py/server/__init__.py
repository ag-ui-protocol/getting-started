import uvicorn
from fastapi import FastAPI

from .routers.agentic_chat import agentic_chat_router
from .routers.human_in_the_loop import human_in_the_loop_router
from .routers.agentic_generative_ui import agentic_generative_ui_router

app = FastAPI(title="AG-UI Llama-Index Endpoint")

app.include_router(agentic_chat_router, prefix="/agentic_chat")
app.include_router(human_in_the_loop_router, prefix="/human_in_the_loop")
app.include_router(agentic_generative_ui_router, prefix="/agentic_generative_ui")

def main():
    """Main function to start the FastAPI server."""
    uvicorn.run(app, host="127.0.0.1", port=9000)

if __name__ == "__main__":
    main()

__all__ = ["main"]
