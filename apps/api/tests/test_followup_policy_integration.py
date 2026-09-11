"""Combined boundaries: stored arithmetic and freshness holds do not confer permissions."""

import pytest
from fastapi import HTTPException
from test_calculation_followup import pair as arithmetic_pair
from test_freshness_followup import _pair as freshness_pair
from test_freshness_runtime import _events, _forbid_side_effects
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession, Message, Role, RoutingMode
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services import calculation_policy, freshness
from app.services.tools.arithmetic import CALCULATE

FOLLOWUP = "그 결과에 17을 더해줘."
MIXED = FOLLOWUP + " 현재 대한민국 대통령은 누구야?"


async def setup(monkeypatch, mode, *, strict=False):
    user = User(email="synthetic@example.test", password_hash="hash")
    model = {**_external_model("synthetic/model"), "supportsTools": True}
    if strict:
        model.update(strictLocal=True, dataBoundary="self_hosted", creditCost=0)
    session = ChatSession(user_id=user.id, model=model["id"], routing_mode=mode)
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    return user, session


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
@pytest.mark.parametrize("boundary", ["off", "strict", "calculator_only"])
async def test_current_fact_with_result_reference_still_requires_lookup(
    monkeypatch, mode, boundary,
):
    user, session = await setup(monkeypatch, mode, strict=boundary == "strict")
    previous = arithmetic_pair(session.id)

    async def history(*_args):
        return previous

    async def tools(*_args, **_kwargs):
        return [CALCULATE] if boundary == "calculator_only" else []

    monkeypatch.setattr(sessions, "_history", history)
    monkeypatch.setattr(sessions, "build_tools", tools)
    _forbid_side_effects(monkeypatch)
    assert freshness.fresh_fact_required(MIXED)
    # Mixed requests are deliberately outside the whole-message arithmetic cue.
    assert not calculation_policy.is_calculation_followup(MIXED)
    db = _NoWriteDb()
    response = await sessions.send_message(
        session.id, SendMessage(content=MIXED, web_search=boundary != "off"),
        _request(), user, db,
    )
    events = await _events(response)
    assert events[0]["type"] == "freshness_abstention"
    assert not any(event["type"] == "model_route" for event in events)
    answer = next(
        row for row in db.added if isinstance(row, Message) and row.role is Role.assistant
    )
    assert answer.model is None and answer.usage["credits"] == 0
    assert answer.routing["answerOrigin"] == "server_policy"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
@pytest.mark.parametrize("calculator_allowed", [False, True])
async def test_new_arithmetic_chain_after_old_hold_uses_only_permitted_calculator(
    monkeypatch, mode, calculator_allowed,
):
    user, session = await setup(monkeypatch, mode)
    previous = freshness_pair(session) + arithmetic_pair(session.id)
    captured = {}
    keys = []

    async def history(*_args):
        return previous

    async def tools(*_args, **_kwargs):
        return [CALCULATE] if calculator_allowed else []

    async def run(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    async def key(*_args, **_kwargs):
        keys.append(True)

    async def credentials(*_args):
        return "http://unused.test", "synthetic-unused-key"

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    monkeypatch.setattr(sessions, "_history", history)
    monkeypatch.setattr(sessions, "build_tools", tools)
    monkeypatch.setattr(sessions, "_run_turn", run)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    db = Db()
    if not calculator_allowed:
        with pytest.raises(HTTPException) as caught:
            await sessions.send_message(
                session.id, SendMessage(content=FOLLOWUP, web_search=False),
                _request(), user, db,
            )
        assert caught.value.status_code == 409
        assert caught.value.detail == "calculation_tool_unavailable"
        assert db.added == [] and db.commits == 0 and keys == [] and captured == {}
        return
    response = await sessions.send_message(
        session.id, SendMessage(content=FOLLOWUP, web_search=False), _request(), user, db,
    )
    _ = [part async for part in response.body_iterator]
    assert captured["calculation_required"] is True
    assert captured["calculation_expression"] is None
    assert captured["preflight_tool"] == "calculate"
    assert captured["freshness_request"] is None
    assert captured["tools"] == [CALCULATE]
    assert captured["model"]["id"] == session.model
    assert captured["messages"][-1] == {"role": "user", "content": FOLLOWUP}


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
async def test_intervening_freshness_hold_breaks_arithmetic_context(monkeypatch, mode):
    user, session = await setup(monkeypatch, mode)
    previous = arithmetic_pair(session.id) + freshness_pair(session)

    async def history(*_args):
        return previous

    async def tools(*_args, **_kwargs):
        return []

    class NormalRoute(Exception):
        pass

    def reached(*_args):
        raise NormalRoute

    monkeypatch.setattr(sessions, "_history", history)
    monkeypatch.setattr(sessions, "build_tools", tools)
    monkeypatch.setattr(sessions, "has_headroom", reached)
    # A result-reference alone does not reopen either earlier topic through a hold.
    with pytest.raises(NormalRoute):
        await sessions.send_message(
            session.id, SendMessage(content=FOLLOWUP, web_search=False),
            _request(), user, _NoWriteDb(),
        )
