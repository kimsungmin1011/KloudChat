"""Compatibility of two independent PRs; all lookup/model/storage calls are synthetic."""

import json
from dataclasses import replace

import pytest
from fastapi import HTTPException
from test_freshness_runtime import _forbid_side_effects
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request
from test_tool_result_answer import _database

from app.models.chat import ChatSession, Message, Role, RoutingMode
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services import agent, calculation_policy, freshness
from app.services.tools.arithmetic import CALCULATE
from app.services.tools.base import SearchEvidence, Tool, ToolContext, ToolResult
from app.services.workspace_context import AppliedSkill, WorkspaceContext

QUESTION = "현재 대한민국 대통령은 누구야? 그리고 12 + 3을 계산해줘."


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "failed", "empty", "link_only"])
@pytest.mark.parametrize("literal_preset", [False, True])
async def test_search_precedes_calculation_and_unusable_source_releases_no_model(
    monkeypatch, outcome, literal_preset
):
    calls = []
    drafts = []

    async def lookup(_arguments):
        calls.append("search")
        return ToolResult(
            content="Synthetic current-source passage",
            failed=outcome == "failed",
            empty=outcome == "empty",
            search_evidence=SearchEvidence(("https://example.test/source",))
            if outcome == "success"
            else None,
        )

    async def calculate(arguments):
        calls.append("calculate")
        return await CALCULATE.run(arguments)

    async def completion(_model, messages, tools, *_args, **kwargs):
        calls.append("model")
        assert "Synthetic current-source passage" in json.dumps(messages)
        acc = agent._Accumulator()
        if not literal_preset and "calculate" not in calls:
            assert [tool.name for tool in tools] == ["calculate"]
            assert kwargs["force_tool"] == "calculate"
            drafts.append("UNVERIFIED_DRAFT")
            acc.content = [drafts[-1]]
            yield "delta", drafts[-1]
            acc.calls[0] = {"id": "calc", "name": "calculate", "arguments": '{"expression":"12+3"}'}
        else:
            assert "15" in json.dumps(messages)
            acc.content = ["Synthetic current fact; 12+3=15"]
            yield "delta", acc.content[0]
        acc.usage = {"inputTokens": 2, "outputTokens": 2}
        yield "done", acc

    monkeypatch.setattr(agent, "_stream_once", completion)
    monkeypatch.setattr(agent.settings, "max_tool_hops", 2)
    search = Tool(
        name="web_search",
        description="synthetic",
        parameters={"type": "object"},
        run=lookup,
        label="search",
    )
    ctx = ToolContext(user_id="synthetic", session_id="synthetic")
    events = [
        event
        async for event in agent.run_turn(
            "synthetic/model",
            [{"role": "user", "content": QUESTION}],
            [search, replace(CALCULATE, run=calculate)],
            ctx,
            preset_call=("web_search", {"query": QUESTION}),
            freshness_request=QUESTION,
            calculation_required=True,
            preflight_tool="calculate",
            calculation_expression="12+3" if literal_preset else None,
        )
    ]
    text = "".join(event["text"] for event in events if event["type"] == "delta")
    assert "UNVERIFIED_DRAFT" not in text
    if outcome == "success":
        assert calls == (
            ["search", "calculate", "model"]
            if literal_preset
            else ["search", "model", "calculate", "model"]
        )
        assert ctx.tool_calls == {"web_search": 1, "calculate": 1}
        assert text == "Synthetic current fact; 12+3=15"
    else:
        assert calls == ["search"]
        assert text == freshness.abstention_response(QUESTION)
        assert any(event["type"] == "freshness_abstention" for event in events)
        assert next(event for event in events if event["type"] == "usage")["inputTokens"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
@pytest.mark.parametrize("boundary", ["off", "strict", "allowlist", "ncs"])
async def test_unavailable_current_fact_precedes_calculator_or_auto_side_effects(
    monkeypatch, mode, boundary
):
    assert calculation_policy.requires_calculation(QUESTION)
    assert freshness.fresh_fact_required(QUESTION)
    user = User(email="synthetic@example.test", password_hash="hash")
    model = {**_external_model("synthetic/model"), "supportsTools": True}
    if boundary == "strict":
        model.update(strictLocal=True, dataBoundary="self_hosted", creditCost=0)
    session = ChatSession(user_id=user.id, model=model["id"], routing_mode=mode)
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    _forbid_side_effects(monkeypatch)

    async def forbidden(_arguments):
        pytest.fail("a blocked current fact executed a tool")

    search = Tool(
        name="web_search",
        description="synthetic",
        parameters={"type": "object"},
        run=forbidden,
        label="search",
    )

    async def tools(*_args, **kwargs):
        # Leave calculate absent: freshness must not fall through to its409.
        return [search] if kwargs.get("web_search") and boundary != "allowlist" else []

    async def context(*_args, **_kwargs):
        return WorkspaceContext((), (AppliedSkill("ncs", "NCS", "ncs-arithmetic", 1),))

    monkeypatch.setattr(sessions, "build_tools", tools)
    if boundary == "ncs":
        monkeypatch.setattr(sessions, "assemble", context)
    db = _NoWriteDb()
    response = await sessions.send_message(
        session.id,
        SendMessage(content=QUESTION, web_search=boundary != "off"),
        _request(),
        user,
        db,
    )
    _ = [chunk async for chunk in response.body_iterator]
    answer = next(
        row for row in db.added if isinstance(row, Message) and row.role == Role.assistant
    )
    assert answer.model is None and answer.routing["answerOrigin"] == "server_policy"
    assert answer.usage["credits"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("gate", ["ncs", "remote_calculate", "write_calculate"])
async def test_only_a_trusted_read_only_calculator_can_follow_the_lookup(monkeypatch, gate):
    def forbidden(*_args, **_kwargs):
        pytest.fail("an exclusive NCS gate permitted a current-fact lookup/model")

    monkeypatch.setattr(agent, "_stream_once", forbidden)
    search = Tool(
        name="web_search",
        description="synthetic",
        parameters={"type": "object"},
        run=forbidden,
        label="search",
    )
    name = "check_ncs_answer" if gate == "ncs" else "calculate"
    calculator = replace(
        CALCULATE,
        name=name,
        run=forbidden,
        source="mcp" if gate == "remote_calculate" else "builtin",
        read_only=gate != "write_calculate",
    )
    events = [
        event
        async for event in agent.run_turn(
            "synthetic/model",
            [{"role": "user", "content": QUESTION}],
            [search, calculator],
            ToolContext(user_id="synthetic", session_id="synthetic"),
            preset_call=("web_search", {"query": QUESTION}),
            freshness_request=QUESTION,
            calculation_required=True,
            preflight_tool=name,
        )
    ]
    assert any(event["type"] == "freshness_abstention" for event in events)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
@pytest.mark.parametrize("calculator_allowed", [False, True])
async def test_route_passes_both_gates_without_widening_calculator_permission(
    monkeypatch, mode, calculator_allowed
):
    user = User(email="synthetic@example.test", password_hash="hash")
    model = {**_external_model("synthetic/model"), "supportsTools": True}
    session = ChatSession(user_id=user.id, model=model["id"], routing_mode=mode)
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    captured = {}
    keys = []

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    async def unused(_arguments):
        pytest.fail("the routing test executed a tool")

    search = Tool(
        name="web_search",
        description="synthetic",
        parameters={"type": "object"},
        run=unused,
        label="search",
    )

    async def tools(*_args, **_kwargs):
        return [search, *([CALCULATE] if calculator_allowed else [])]

    async def run(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    async def key(*_args):
        keys.append(True)
        return None

    async def credentials(*_args):
        return "synthetic-origin", "synthetic-noncredential"

    def forbidden(*_args, **_kwargs):
        pytest.fail("a required current-fact lookup reached Auto classification")

    monkeypatch.setattr(sessions, "build_tools", tools)
    monkeypatch.setattr(sessions, "_run_turn", run)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions.adaptive_routing, "classify", forbidden)
    db = Db()
    payload = SendMessage(content=QUESTION, web_search="auto")
    if not calculator_allowed:
        with pytest.raises(HTTPException) as caught:
            await sessions.send_message(session.id, payload, _request(), user, db)
        assert caught.value.detail == "calculation_tool_unavailable"
        assert caught.value.status_code == 409
        assert db.added == [] and keys == [] and captured == {}
        return
    response = await sessions.send_message(session.id, payload, _request(), user, db)
    _ = [chunk async for chunk in response.body_iterator]
    assert captured["freshness_request"] == QUESTION
    assert captured["calculation_required"] is True
    assert captured["preflight_tool"] == "calculate"
    assert captured["preset_call"][0] == "web_search"
    assert captured["force_tool"] is None
    assert captured["calculation_expression"] is None
    assert {tool.name for tool in captured["tools"]} == {"web_search", "calculate"}


@pytest.mark.parametrize("verified", [False, True])
@pytest.mark.parametrize("mask_at_rest", [False, True])
async def test_terminal_origins_share_null_model_accounting_and_preserve_privacy(
    monkeypatch, verified, mask_at_rest,
):
    user, session, cost_route, audit, added = _database(monkeypatch, mode=RoutingMode.auto_quality)
    searches = []

    def forbidden(*_args, **_kwargs):
        pytest.fail("a source hold or literal calculator answer reached generation or enrichment")

    async def lookup(_arguments):
        return ToolResult(
            content="Synthetic current-source passage",
            failed=not verified,
            search_evidence=SearchEvidence(("https://example.test/current",)) if verified else None,
        )

    monkeypatch.setattr(agent, "_stream_once", forbidden)
    for name in [
        "_store_artifacts", "_enrich_memory", "_enrichment_model", "_store_notes",
        "settle", "charge_for_tokens",
    ]:
        monkeypatch.setattr(sessions, name, forbidden)
    monkeypatch.setattr(sessions.chat_service, "generate_title", forbidden)
    monkeypatch.setattr(
        sessions, "record_searches", lambda _db, _user, count, **_kwargs: searches.append(count)
    )
    search = Tool(
        name="web_search", description="synthetic", parameters={"type": "object"},
        run=lookup, label="search", read_only=True,
    )
    privacy = {
        "action": "mask_external", "actualModel": "synthetic/paid",
        "findingCounts": [{"category": "email", "source": "request", "count": 1}],
    }
    chunks = [chunk async for chunk in sessions._run_turn(
        user_id=user.id, api_key="synthetic-noncredential", auto_memory=True,
        session_id=session.id, model=_external_model("synthetic/paid"),
        messages=[{"role": "user", "content": QUESTION}], tools=[search, CALCULATE],
        first_user_message=QUESTION, is_first_turn=True,
        preflight_tool="calculate", calculation_required=True, calculation_expression="12/0",
        freshness_request=QUESTION, preset_call=("web_search", {"query": QUESTION}),
        routing={**privacy, "costRouting": cost_route}, routing_audit_id=audit.id,
        mask_at_rest=mask_at_rest,
    )]
    events = [json.loads(chunk.removeprefix("data: ").strip()) for chunk in chunks]
    answer = next(row for row in added if isinstance(row, Message))
    expected = "tool_result_answer" if verified else "freshness_abstention"
    origins = [event for event in events if event["type"] in {
        "tool_result_answer", "freshness_abstention",
    }]
    assert len(origins) == 1 and origins[0]["type"] == expected
    assert answer.model is None and answer.routing["actualModel"] is None
    assert answer.routing["answerOrigin"] == ("tool_result" if verified else "server_policy")
    assert answer.routing["action"] == privacy["action"]
    assert answer.routing["findingCounts"] == privacy["findingCounts"]
    assert "costRouting" not in answer.routing
    assert answer.usage == {"inputTokens": 0, "outputTokens": 0, "credits": 0}
    assert answer.artifact_ids is None and answer.failure is None
    assert searches == [1]
    assert audit.event_metadata == {**cost_route, **answer.routing, "executedModel": None}
    assert not any(event["type"] == "model_route" for event in events)
    if verified:
        assert "0으로 나누" in answer.content
    else:
        assert answer.content == freshness.abstention_response(QUESTION)
