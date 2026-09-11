"""Assembles the tool list for one turn.

Built-ins win name collisions (the loop resolves tools by name); connector tools
are namespaced `mcp__<slug>__<tool>`.
"""

from __future__ import annotations

import logging

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.user import User
from app.models.workspace import Connector, ConnectorStatus, ConnectorTool
from app.services import mcp
from app.services.tools import catalog
from app.services.tools.base import Tool, ToolResult
from app.services.tools.builtin import (
    CALCULATE,
    CHECK_NCS_ANSWER,
    CREATE_ARTIFACT,
    CREATE_CHART,
    EXECUTE_CODE,
    FETCH_URL,
    SHARE_NOTE,
    WEB_SEARCH,
    available_builtins,
    knowledge_tool,
)

log = logging.getLogger(__name__)

_NS = "mcp__"


def qualified(slug: str, tool_name: str) -> str:
    return f"{_NS}{slug}__{tool_name}"


def _label_for(connector: Connector, tool_name: str) -> str:
    pretty = tool_name.replace("_", " ")
    return f"{connector.name} · {pretty}"


def _make_runner(connector: Connector, tool_name: str, env: dict[str, str]):
    async def run(arguments: dict) -> ToolResult:
        try:
            endpoint = await catalog.effective_endpoint(connector)
            text = await mcp.call_tool(
                connector.transport.value, endpoint, tool_name, arguments, env
            )
        except mcp.McpError as exc:
            return ToolResult(content=f"오류: {exc}", failed=True)
        if not text:
            return ToolResult(content="(빈 응답)", detail="결과 없음", empty=True)
        # Caps what a server can push into the context.
        capped = text[:30_000]
        detail = f"{len(text):,}자" + (" (일부)" if len(text) > 30_000 else "")
        return ToolResult(content=capped, detail=detail)

    return run


async def connector_tools(db: AsyncSession, user: User) -> list[Tool]:
    """Every enabled tool from every enabled, connected connector this user has."""
    connectors = (
        await db.exec(
            select(Connector).where(
                Connector.owner_id == user.id,
                Connector.installed == True,  # noqa: E712 — SQL, not Python truthiness
                Connector.enabled == True,  # noqa: E712
                Connector.status == ConnectorStatus.connected,
            )
        )
    ).all()
    if not connectors:
        return []

    rows = (
        await db.exec(
            select(ConnectorTool).where(
                ConnectorTool.connector_id.in_([c.id for c in connectors]),  # type: ignore[attr-defined]
                ConnectorTool.enabled == True,  # noqa: E712
            )
        )
    ).all()

    by_id = {c.id: c for c in connectors}
    out: list[Tool] = []
    for row in rows:
        connector = by_id.get(row.connector_id)
        if connector is None:
            continue
        env = mcp.substitute(
            await catalog.resolve_env(connector.env),
            user_id=user.id,
            user_email=user.email,
        )
        out.append(
            Tool(
                name=qualified(connector.slug, row.name),
                description=row.description or f"{connector.name} 의 {row.name} 도구",
                parameters=row.parameters or {"type": "object", "properties": {}},
                run=_make_runner(connector, row.name, env),
                label=_label_for(connector, row.name),
                read_only=row.read_only,
                source=connector.slug,
            )
        )
    # Stable order: the privacy decision token hashes the exact tool list.
    return sorted(out, key=lambda tool: tool.name)


async def build_tools(
    db: AsyncSession,
    user: User,
    *,
    web_search: bool,
    allowed: list[str] | None = None,
    knowledge: list[tuple[str, str, str | None]] | None = None,
    knowledge_collection: str = "",
    include_connectors: bool = True,
    strict_local: bool = False,
) -> list[Tool]:
    """The turn's tool list.

    `allowed`: None inherits everything the user has, [] denies all, a list is a hard filter.
    `knowledge`: the agent's documents, offered as `search_knowledge` under the same allowlist.
    """
    if strict_local:
        # Only in-process built-ins; no connectors, no vector retrieval. `share_note`
        # is excluded because a note reaches later turns that may run on external models.
        tools = [CALCULATE, CHECK_NCS_ANSWER, CREATE_ARTIFACT, CREATE_CHART]
        include_connectors = False
        knowledge_collection = ""
    else:
        tools = await available_builtins(web_search)
    seen = {t.name for t in tools}

    if include_connectors:
        for tool in await connector_tools(db, user):
            if tool.name in seen:
                log.warning("connector tool %s shadows a built-in; ignored", tool.name)
                continue
            seen.add(tool.name)
            tools.append(tool)

    if allowed is not None:
        keep = set(allowed)
        tools = [t for t in tools if t.name in keep]
    if knowledge and (allowed is None or "search_knowledge" in allowed):
        tools.append(knowledge_tool(knowledge, knowledge_collection))
    return tools


async def tool_catalog(db: AsyncSession, user: User) -> list[dict[str, object]]:
    """Tool names an agent or skill may reference, with labels and current availability."""
    available = {tool.name: tool for tool in await build_tools(db, user, web_search=True)}
    known: dict[str, tuple[str, bool]] = {
        tool.name: (tool.title or tool.label or tool.name, tool.name in available)
        for tool in (
            CALCULATE,
            CHECK_NCS_ANSWER,
            WEB_SEARCH,
            FETCH_URL,
            EXECUTE_CODE,
            CREATE_ARTIFACT,
            CREATE_CHART,
            SHARE_NOTE,
        )
    }

    # Connector names stay valid while disconnected; availability is rechecked at execution.
    connectors = (
        await db.exec(
            select(Connector).where(
                Connector.owner_id == user.id,
                Connector.installed == True,  # noqa: E712
            )
        )
    ).all()
    if connectors:
        connector_rows = (
            await db.exec(
                select(ConnectorTool).where(
                    ConnectorTool.connector_id.in_([item.id for item in connectors])  # type: ignore[attr-defined]
                )
            )
        ).all()
        by_id = {item.id: item for item in connectors}
        for row in connector_rows:
            connector = by_id.get(row.connector_id)
            if connector is None:
                continue
            name = qualified(connector.slug, row.name)
            known[name] = (_label_for(connector, row.name), name in available)

    # Exists only for an agent with shelf documents (see AgentOut.has_knowledge).
    known["search_knowledge"] = ("에이전트 지식이 있을 때 검색", False)
    return [
        {"name": name, "label": label, "available": is_available}
        for name, (label, is_available) in known.items()
    ]
