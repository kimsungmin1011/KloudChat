"""Tool contract shared by every provider: an OpenAI function definition plus a runner."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Tool:
    name: str
    description: str
    #: JSON Schema for the arguments, as the OpenAI tools API expects.
    parameters: dict[str, Any]
    run: Callable[[dict[str, Any]], Awaitable[str]]
    #: Shown in the UI while the call is in flight, e.g. "searching the web".
    label: str
    #: The tool as a noun, e.g. "web search", for permission lists and finished steps.
    #: Empty falls back to `label`.
    title: str = ""
    #: Read-only tools run unattended; write tools are gated.
    read_only: bool = True
    #: Provider slug, for the audit trail and the UI badge.
    source: str = "builtin"
    #: `run` receives the `ToolContext` as a second argument.
    wants_context: bool = False


@dataclass(frozen=True, slots=True)
class SearchEvidence:
    """Trusted builtin metadata: linked snippet/body presence, not truth or freshness.

    Kept outside tool-result text so remote content cannot declare itself verified.
    Only the in-process web-search parser constructs this value.
    """

    source_urls: tuple[str, ...]


@dataclass(slots=True)
class ToolResult:
    """What the loop feeds back to the model, plus what the UI should show."""

    content: str
    #: Optional extra line under the step, e.g. "5 results".
    detail: str | None = None
    #: Marks the step red without aborting the turn.
    failed: bool = False
    #: Ran but found nothing usable; the loop counts these per turn.
    empty: bool = False
    #: A trusted in-process tool may finish the turn without another model hop.
    #: The loop applies the same output/privacy masking before showing this text.
    final_text: str | None = None
    search_evidence: SearchEvidence | None = None


@dataclass(slots=True)
class ToolContext:
    """Per-request state a tool may need; explicit so a tool cannot reach another user's data."""

    user_id: str
    session_id: str
    #: The caller's LiteLLM virtual key, so model calls are billed to them.
    api_key: str = ""
    #: Tool names enabled for this turn; empty means all available.
    allowed: set[str] = field(default_factory=set)
    #: Scope of a shared note: the project when set, else this session.
    project_id: str = ""
    #: Byline on a shared note; empty on a plain conversation.
    agent_name: str = ""
    #: The user's own message text; `create_artifact` checks it for a file request.
    request: str = ""
    #: Artifacts to store after the turn finishes, in call order (tools hold no DB session).
    pending_artifacts: list[dict] = field(default_factory=list)
    #: Shared notes to store after the turn finishes.
    pending_notes: list[dict] = field(default_factory=list)
    #: Calls that actually ran this turn, by tool name. `web_search` reaches
    #: the usage ledger as searches; a repeated call the loop refused is not here.
    tool_calls: dict[str, int] = field(default_factory=dict)


def to_openai(tools: list[Tool]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in tools
    ]


def openai_snapshot(tools: list[Tool]) -> list[dict[str, Any]]:
    """Detached copy of `to_openai`, so a privacy decision binds bytes no callback can mutate."""
    return json.loads(json.dumps(to_openai(tools), ensure_ascii=False))
