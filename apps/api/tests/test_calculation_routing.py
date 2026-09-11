"""A required calculation survives routing without widening an Agent allowlist."""

import json

import pytest
from fastapi import HTTPException
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession, Message, Role, RoutingMode
from app.models.governance import Governance
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.tools.arithmetic import CALCULATE
from app.services.tools.ncs_check import CHECK_NCS_ANSWER


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [RoutingMode.manual, RoutingMode.auto, RoutingMode.auto_quality])
@pytest.mark.parametrize("tool", [CALCULATE, CHECK_NCS_ANSWER, None])
@pytest.mark.parametrize(
    "request_kind", ["word_problem", "literal", "followup_add", "followup_percent"],
)
async def test_calculation_requirement_precedes_tool_free_routing_and_key_issue(
    monkeypatch,
    mode,
    tool,
    request_kind,
):
    user = User(email="calculation@example.test", password_hash="hash", name="Learner")
    model = {
        **_external_model("synthetic/quality"),
        "supportsTools": True,
        "inputCreditCost": 10,
        "creditCost": 20,
        "contextWindow": 64_000,
    }
    classifier = {
        **_external_model("strict-local/classifier"),
        "dataBoundary": "self_hosted",
        "strictLocal": True,
        "privacyOnly": True,
        "inputCreditCost": 0,
        "creditCost": 0,
        "contextWindow": 32_000,
    }
    economy = {
        **_external_model("synthetic/economy"),
        "inputCreditCost": 1,
        "creditCost": 2,
        "contextWindow": 32_000,
        "supportsTools": False,
    }
    upgrade = {**model, "id": "synthetic/upgraded", "inputCreditCost": 20, "creditCost": 40}
    session = ChatSession(user_id=user.id, model=model["id"], routing_mode=mode)
    await _patch_guard_dependencies(
        monkeypatch,
        session=session,
        models=[model, classifier, economy, upgrade],
        blocks=[],
    )
    literal = request_kind == "literal"
    if request_kind.startswith("followup"):
        history = [
            Message(session_id=session.id, role=Role.user, content=(
                "NCS 수리 문제: 25 * 16을 계산해줘."
                if tool is CHECK_NCS_ANSWER else "25 * 16은 얼마야?"
            )),
            Message(
                session_id=session.id, role=Role.assistant,
                content="25 * 16 = 400", model=model["id"],
            ),
        ]
        if request_kind == "followup_percent":
            history.extend([
                Message(session_id=session.id, role=Role.user, content="그 결과에 25를 더해줘."),
                Message(
                    session_id=session.id, role=Role.assistant,
                    content="400 + 25 = 425", model=model["id"],
                ),
            ])

        async def stored_history(*_args):
            return history

        monkeypatch.setattr(sessions, "_history", stored_history)
    captured = {}
    keys = []
    classifications = []

    async def tools(*_args, **_kwargs):
        return [tool] if tool else []

    async def policy(*_args, **_kwargs):
        return Governance(
            external_data_guard=True,
            adaptive_routing_enabled=True,
            adaptive_classifier_model_id=classifier["id"],
            adaptive_economy_model_ids=[economy["id"]],
            adaptive_quality_enabled=True,
            adaptive_quality_model_ids=[upgrade["id"]],
        )

    async def classify(**_kwargs):
        assert mode == RoutingMode.auto_quality
        classifications.append(True)
        return sessions.adaptive_routing.Classification("high", 0.99, "multi_step", 10, 2)

    async def key(*_args, **_kwargs):
        keys.append(True)
        return "synthetic-unused-key"

    async def credentials(*_args, **_kwargs):
        return "http://unused.test", "synthetic-unused-key"

    async def stream(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    db = Db()
    monkeypatch.setattr(sessions, "build_tools", tools)
    monkeypatch.setattr(sessions.governance, "current_for_egress", policy)
    monkeypatch.setattr(sessions.adaptive_routing, "classify", classify)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions.litellm_service, "user_key", lambda _user: "synthetic-unused-key")
    monkeypatch.setattr(sessions, "_run_turn", stream)

    request = SendMessage(
        content=(
            "그 결과에 25를 더해줘. 계산식과 답만 짧게 써줘. 파일은 만들지 마."
            if request_kind == "followup_add" else
            "그 합계의 20%는 얼마야? 계산식과 답만 짧게 써줘. 파일은 만들지 마."
            if request_kind == "followup_percent" else
            ("NCS 수리 문제: " if tool is CHECK_NCS_ANSWER else "") + (
            "17 * 23은 얼마야? 계산식과 답만 짧게 써줘. 파일은 만들지 마."
            if literal else "A팀 7명의 평균 68점, B팀 3명의 평균 92점이면 전체 평균은?"
            )
        ),
        web_search=False,
    )
    if tool is None:
        with pytest.raises(HTTPException) as caught:
            await sessions.send_message(session.id, request, _request(), user, db)
        assert caught.value.status_code == 409
        assert caught.value.detail == "calculation_tool_unavailable"
        assert db.added == [] and db.commits == 0 and keys == [] and classifications == []
        return
    response = await sessions.send_message(session.id, request, _request(), user, db)
    _ = [part async for part in response.body_iterator]
    assert captured["preflight_tool"] == tool.name
    assert captured["tools"] == [tool]
    assert captured["model"]["id"] == (
        upgrade["id"] if mode == RoutingMode.auto_quality else model["id"]
    )
    assert [row["function"]["name"] for row in captured["tool_definitions"]] == [tool.name]
    assert "계산" in captured["messages"][0]["content"]
    assert captured["calculation_required"] is True
    assert captured["messages"][-1] == {"role": "user", "content": request.content}
    if request_kind.startswith("followup"):
        wire = [
            {"role": message.role.value, "content": message.content} for message in history
        ] + [{"role": "user", "content": request.content}]
        assert captured["messages"][-len(wire):] == wire
    assert captured["calculation_expression"] == (
        "17 * 23" if literal and tool is CALCULATE else None
    )
    if mode == RoutingMode.auto:
        route = captured["routing"]["costRouting"]
        assert route["decision"] == "bypassed"
        assert route["reasonCode"] == "calculation_required"
    elif mode == RoutingMode.auto_quality:
        assert len(classifications) == 1
        assert captured["routing"]["costRouting"]["decision"] == "routed"
    assert "synthetic-unused-key" not in json.dumps(captured["messages"])
