"""Tests for the AG-UI Docs Copilot example."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLES))

from agents_examples import ag_ui_docs_copilot  # noqa: E402
from agents_examples.ag_ui_docs_copilot import MarkdownSections  # noqa: E402


def test_docs_copilot_loads_the_integration_readme() -> None:
    assert "AG-UI × OpenAI Agents SDK" in ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS
    assert "AGUITranslator" in ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS
    assert "ag-ui-protocol" in ag_ui_docs_copilot.AG_UI_PROTOCOL_DOCS
    assert "EventEncoder" in ag_ui_docs_copilot.AG_UI_PROTOCOL_DOCS


def test_docs_copilot_reads_both_doc_sources_directly() -> None:
    assert ag_ui_docs_copilot.copilot_agent.name == "AG-UI Docs Copilot"
    assert {tool.name for tool in ag_ui_docs_copilot.copilot_agent.tools} == {
        "read_ag_ui_openai_agents_docs",
        "read_ag_ui_protocol_docs",
    }


def test_docs_copilot_instructions_carry_both_tocs_but_not_the_docs() -> None:
    instructions = ag_ui_docs_copilot.copilot_instructions
    assert ag_ui_docs_copilot._AG_UI_PROTOCOL_SECTIONS.headings in instructions
    assert ag_ui_docs_copilot._AG_UI_OPENAI_AGENTS_SECTIONS.headings in instructions
    assert ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS not in instructions
    assert ag_ui_docs_copilot.AG_UI_PROTOCOL_DOCS not in instructions


def test_docs_copilot_reads_one_section_by_heading() -> None:
    section = ag_ui_docs_copilot._AG_UI_OPENAI_AGENTS_SECTIONS.read(
        "Backend tool approval"
    )
    assert "needs_approval" in section
    assert len(section) < len(ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS)


def test_markdown_sections_splits_and_matches_loosely() -> None:
    sections = MarkdownSections(
        "intro line\n\n## Setup\npip install it\n\n## Usage Notes\ncall run()\n"
    )
    assert sections.headings == "- Overview\n- Setup\n- Usage Notes"
    assert sections.read("Setup") == "## Setup\npip install it"
    assert sections.read("## usage notes") == "## Usage Notes\ncall run()"
    assert sections.read("usage") == "## Usage Notes\ncall run()"
    assert "Available headings" in sections.read("missing")


def test_markdown_sections_handles_empty_documents() -> None:
    for document in ("", "  \n\t"):
        sections = MarkdownSections(document)
        assert sections.headings == ""
        assert "Available headings" in sections.read("AGUITranslator")


def test_docs_copilot_keeps_the_direct_translator_flow_visible() -> None:
    assert "/" in {route.path for route in ag_ui_docs_copilot.app.routes}
    source = inspect.getsource(ag_ui_docs_copilot.run_ag_ui_docs_copilot)
    assert "translator.to_openai(body)" in source
    assert "Runner.run_streamed(" in source
    assert "translator.to_agui(result, body)" in source
