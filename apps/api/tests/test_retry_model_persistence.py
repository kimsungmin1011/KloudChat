"""Model overrides use real HTTP/SQLite persistence and synthetic model runners."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import JSON, MetaData
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession
from test_privacy import _external_model, _patch_guard_dependencies

from app.core.db import get_session
from app.core.deps import current_user
from app.models.chat import ChatSession, Message, Role, RoutingMode, SessionKind, TurnFailure
from app.models.user import User
from app.models.workspace import Agent, StoredFile
from app.routers import sessions

ORIGINAL = "fixture/original"
OVERRIDE = "fixture/one-turn"
AGENT = "fixture/agent"


@pytest.fixture
async def engine():
    metadata = MetaData()
    for table in SQLModel.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for column in copy.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
                column.server_default = None
    engine = create_async_engine("sqlite+aiosqlite://")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                metadata.create_all,
                tables=[
                    metadata.tables[model.__tablename__]
                    for model in (User, Agent, ChatSession, Message, StoredFile)
                ],
            )
        yield engine
    finally:
        await engine.dispose()


async def setup(
    monkeypatch,
    engine,
    *,
    kind,
    state="saved",
    mode=RoutingMode.manual,
    allow_override=True,
    catalogue_override=True,
    failed=True,
):
    user = User(
        id="fixture-user",
        email="fixture@example.test",
        name="Fixture",
        password_hash="unused",
        allowed_models=[ORIGINAL, AGENT] + ([OVERRIDE] if allow_override else []),
    )
    agent = Agent(id="fixture-agent", owner_id=user.id, name="Fixture Agent", model=AGENT, tools=[])
    session = ChatSession(
        id="fixture-session",
        user_id=user.id,
        kind=kind,
        title="Fixture",
        model=ORIGINAL if state == "saved" else "",
        agent_id=agent.id if state == "agent" else None,
        routing_mode=mode,
    )
    question = Message(
        id="fixture-question",
        session_id=session.id,
        role=Role.user,
        content="Explain the saved subject briefly.",
        failure=TurnFailure.no_answer,
    )
    async with AsyncSession(engine, expire_on_commit=False) as db:
        db.add_all([user, agent, session])
        if failed:
            db.add(question)
        await db.commit()
    models = [
        {
            **_external_model(model),
            "kinds": [kind.value],
            "creditCost": 0.5 if model == ORIGINAL else 1,
        }
        for model in [ORIGINAL, AGENT] + ([OVERRIDE] if catalogue_override else [])
    ]
    real_owned, real_history = sessions._owned, sessions._history
    await _patch_guard_dependencies(monkeypatch, session=session, models=models, blocks=[])
    monkeypatch.setattr(sessions, "_owned", real_owned)
    monkeypatch.setattr(sessions, "_history", real_history)

    async def agent_settings(*args, **kwargs):
        return (AGENT if state == "agent" else None), [], None

    async def ensure_key(*args, **kwargs):
        return "fixture-only"

    async def credentials(*args, **kwargs):
        return "http://fixture.invalid", "fixture-only"

    async def build_tools(*args, **kwargs):
        return []

    executed = []

    async def run(**kwargs):
        executed.append(kwargs["model"]["id"])
        yield sessions.chat_service.sse({"type": "delta", "text": "Synthetic answer"})
        yield sessions.chat_service.sse({"type": "done"})

    monkeypatch.setattr(sessions, "agent_settings", agent_settings)
    monkeypatch.setattr(sessions, "has_headroom", lambda *args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", ensure_key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions, "build_tools", build_tools)
    for name in ("_run_turn", "_run_report", "_run_deck"):
        monkeypatch.setattr(sessions, name, run)

    async def db_session():
        async with AsyncSession(engine, expire_on_commit=False) as db:
            yield db

    app = FastAPI()
    app.include_router(sessions.router)
    app.dependency_overrides[get_session] = db_session
    app.dependency_overrides[current_user] = lambda: user
    return app, session, question, executed


async def saved_model(engine, session_id):
    async with AsyncSession(engine) as db:
        row = await db.get(ChatSession, session_id)
        return row.model, row.routing_mode


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(SessionKind)[:3])
@pytest.mark.parametrize("state", ["saved", "agent", "initial"])
async def test_retry_override_does_not_replace_the_saved_model(monkeypatch, engine, kind, state):
    app, session, question, executed = await setup(monkeypatch, engine, kind=kind, state=state)
    original = session.model
    inherited = AGENT if state == "agent" else ORIGINAL
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post(
            f"/sessions/{session.id}/messages",
            json={
                "content": "Client echo",
                "retryOf": question.id,
                "model": OVERRIDE,
            },
        )
        assert response.status_code == 200, response.text
        assert "Synthetic answer" in response.text
        assert executed == [OVERRIDE]
        readback = await client.get(f"/sessions/{session.id}")
        assert readback.status_code == 200
        stored = await saved_model(engine, session.id)
        # Make the next ordinary request before checking the original failure, so
        # a baseline red records both the saved choice and actual runner selection.
        response = await client.post(
            f"/sessions/{session.id}/messages",
            json={
                "content": "Explain another subject briefly.",
            },
        )
        assert response.status_code == 200, response.text
        assert (readback.json()["model"], stored[0], executed) == (
            original,
            original,
            [OVERRIDE, inherited],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [RoutingMode.auto, RoutingMode.auto_quality])
async def test_retry_keeps_the_auto_model_setting(monkeypatch, engine, mode):
    app, session, question, executed = await setup(
        monkeypatch, engine, kind=SessionKind.chat, mode=mode
    )
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post(
            f"/sessions/{session.id}/messages",
            json={
                "content": "Client echo",
                "retryOf": question.id,
                "model": OVERRIDE,
            },
        )
        assert response.status_code == 200, response.text
        assert executed == [OVERRIDE]
    assert await saved_model(engine, session.id) == (ORIGINAL, mode)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(SessionKind)[:3])
async def test_explicit_session_patch_still_changes_the_default(monkeypatch, engine, kind):
    app, session, _, executed = await setup(
        monkeypatch, engine, kind=kind, state="agent", failed=False
    )
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.patch(f"/sessions/{session.id}", json={"model": OVERRIDE})
        assert response.status_code == 200, response.text
        assert await saved_model(engine, session.id) == (OVERRIDE, RoutingMode.manual)
        response = await client.post(
            f"/sessions/{session.id}/messages", json={"content": "Explain a subject."}
        )
        assert response.status_code == 200, response.text
        assert executed == [OVERRIDE]
    assert await saved_model(engine, session.id) == (OVERRIDE, RoutingMode.manual)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(SessionKind)[:3])
async def test_first_plain_send_still_records_the_resolved_default(monkeypatch, engine, kind):
    app, session, _, executed = await setup(
        monkeypatch, engine, kind=kind, state="initial", failed=False
    )
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post(
            f"/sessions/{session.id}/messages", json={"content": "Explain a subject."}
        )
        assert response.status_code == 200, response.text
        assert executed == [ORIGINAL]
    assert await saved_model(engine, session.id) == (ORIGINAL, RoutingMode.manual)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [SessionKind.report, SessionKind.slides])
@pytest.mark.parametrize("state", ["saved", "agent", "initial"])
@pytest.mark.parametrize("selection", ["resolved", "empty"])
async def test_document_payload_model_is_turn_only_without_a_settings_patch(
    monkeypatch, engine, kind, state, selection
):
    app, session, _, executed = await setup(
        monkeypatch, engine, kind=kind, state=state, failed=False
    )
    choice = AGENT if state == "agent" else ORIGINAL
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post(
            f"/sessions/{session.id}/messages",
            json={
                "content": "Explain a subject.",
                "model": choice if selection == "resolved" else "",
            },
        )
        assert response.status_code == 200, response.text
        assert executed == [choice]
    assert await saved_model(engine, session.id) == (session.model, RoutingMode.manual)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [SessionKind.chat, SessionKind.report, SessionKind.slides])
async def test_explicit_model_on_session_creation_is_still_saved(monkeypatch, engine, kind):
    app, _, _, executed = await setup(monkeypatch, engine, kind=kind, failed=False)

    async def enabled_kinds():
        return ["chat", "report", "slides"]

    monkeypatch.setattr(sessions.settings_store, "enabled_kinds", enabled_kinds)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/sessions", json={"kind": kind.value, "model": OVERRIDE})
        assert response.status_code == 201, response.text
        session_id = response.json()["id"]
        assert await saved_model(engine, session_id) == (OVERRIDE, RoutingMode.manual)
        response = await client.post(
            f"/sessions/{session_id}/messages", json={"content": "Explain a subject."}
        )
        assert response.status_code == 200, response.text
        assert executed == [OVERRIDE]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(SessionKind)[:3])
@pytest.mark.parametrize(
    ("allowed", "available", "status", "detail"),
    [
        (False, True, 403, "model_not_allowed"),
        (True, False, 400, "model_unavailable"),
    ],
)
async def test_rejected_retry_model_changes_no_rows(
    monkeypatch, engine, kind, allowed, available, status, detail
):
    app, session, question, executed = await setup(
        monkeypatch, engine, kind=kind, allow_override=allowed, catalogue_override=available
    )
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post(
            f"/sessions/{session.id}/messages",
            json={
                "content": "Client echo",
                "retryOf": question.id,
                "model": OVERRIDE,
            },
        )
        assert response.status_code == status, response.text
        assert response.json()["detail"] == detail
    assert executed == []
    assert await saved_model(engine, session.id) == (ORIGINAL, RoutingMode.manual)
    async with AsyncSession(engine) as db:
        messages = (await db.exec(select(Message))).all()
        assert len(messages) == 1
        assert messages[0].failure == TurnFailure.no_answer
