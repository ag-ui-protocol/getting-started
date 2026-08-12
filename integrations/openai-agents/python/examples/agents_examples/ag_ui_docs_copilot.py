"""AG-UI documentation assistant that reads local README sections on demand."""

from __future__ import annotations

import re
from importlib.metadata import metadata

from agents import Agent, Runner, function_tool
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from .constants import DEFAULT_MODEL

_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$")


def _load_distribution_readme(distribution: str) -> str:
    """Load the installed package README from its distribution metadata."""
    document = metadata(distribution).get_payload()
    if not isinstance(document, str) or not document.strip():
        raise RuntimeError(f"{distribution} has no README in its package metadata")
    return document


class MarkdownSections:
    """A Markdown document split by heading, read one section at a time.

    The Copilot sees only the heading list in its instructions and fetches
    the sections it needs on demand, so the full document never sits in a
    prompt.
    """

    def __init__(self, document: str) -> None:
        sections: dict[str, list[str]] = {}
        heading = "Overview"
        for line in document.splitlines():
            match = _HEADING_RE.match(line)
            if match:
                heading = match.group(1).strip()
            sections.setdefault(heading, []).append(line)
        self._sections = {
            name: content
            for name, lines in sections.items()
            if (content := "\n".join(lines).strip())
        }

    @property
    def headings(self) -> str:
        """The table of contents: one heading per line."""
        return "\n".join(f"- {name}" for name in self._sections)

    def read(self, heading: str) -> str:
        """Return one section by heading (case-insensitive, substring ok)."""
        wanted = heading.strip().lstrip("#").strip().lower()
        for name, content in self._sections.items():
            if name.lower() == wanted:
                return content
        for name, content in self._sections.items():
            if wanted in name.lower():
                return content
        return f"No section matches {heading!r}. Available headings:\n{self.headings}"


# ag-ui-protocol docs: the core Python SDK README.
AG_UI_PROTOCOL_DOCS = _load_distribution_readme("ag-ui-protocol")
_AG_UI_PROTOCOL_SECTIONS = MarkdownSections(AG_UI_PROTOCOL_DOCS)


@function_tool
def read_ag_ui_protocol_docs(heading: str) -> str:
    """Read one AG-UI Protocol Python documentation section by its heading.

    Args:
        heading: A heading from the "AG-UI Protocol docs" table of contents
            in your instructions.
    """
    return _AG_UI_PROTOCOL_SECTIONS.read(heading)


# ag-ui-openai-agents docs: this integration's README.
AG_UI_OPENAI_AGENTS_DOCS = _load_distribution_readme("ag-ui-openai-agents")
_AG_UI_OPENAI_AGENTS_SECTIONS = MarkdownSections(AG_UI_OPENAI_AGENTS_DOCS)


@function_tool
def read_ag_ui_openai_agents_docs(heading: str) -> str:
    """Read one AG-UI OpenAI Agents integration documentation section.

    Args:
        heading: A heading from the "AG-UI OpenAI Agents docs" table of
            contents in your instructions.
    """
    return _AG_UI_OPENAI_AGENTS_SECTIONS.read(heading)


copilot_instructions = f"""You are the developer-facing Copilot for an AG-UI
application. Answer only what the user asks. Be clear, practical, and concise;
do not add a tutorial, unrelated details, alternatives, or follow-up work
unless requested. Handle ordinary conversation directly.

For any question about AG-UI, the OpenAI Agents SDK, translator APIs, FastAPI
endpoints, streaming, tools, client tools, state, lifecycle events, errors,
tests, or Python implementation, pick the most relevant heading from the
matching table of contents below and call the matching tool before answering.
Use read_ag_ui_openai_agents_docs for OpenAI Agents SDK integration questions
and read_ag_ui_protocol_docs for ag_ui.core protocol types and EventEncoder
questions. Treat the returned section as your only source of truth. Read
another section if the first one is not enough.

Use only the part of the section that answers the user's question. Do not
invent behavior or claim details the documentation did not provide. For code
requests, provide only the smallest complete, production-readable Python
snippet needed, followed by a short explanation. Use documented APIs only.

AG-UI Protocol docs table of contents:
{_AG_UI_PROTOCOL_SECTIONS.headings}

AG-UI OpenAI Agents docs table of contents:
{_AG_UI_OPENAI_AGENTS_SECTIONS.headings}
"""

copilot_agent = Agent(
    name="AG-UI Docs Copilot",
    model=DEFAULT_MODEL,
    instructions=copilot_instructions,
    tools=[read_ag_ui_protocol_docs, read_ag_ui_openai_agents_docs],
)

# AGUI Translator Integration
app = FastAPI(title="AG-UI Docs Copilot")
translator = AGUITranslator()


@app.post("/")
async def run_ag_ui_docs_copilot(
    body: RunAgentInput, request: Request
) -> StreamingResponse:
    """Translate one AG-UI request into an SDK run and stream it back."""
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def stream():
        # AGUI input -> OpenAI SDK
        translated_input = translator.to_openai(body)

        # normal OpenAI SDK streaming run
        result = Runner.run_streamed(
            copilot_agent,
            input=translated_input.messages,
            context=translated_input.context,
        )

        # OpenAI SDK -> AGUI events
        async for event in translator.to_agui(result, body):
            yield encoder.encode(event)

    return StreamingResponse(stream(), media_type=encoder.get_content_type())
