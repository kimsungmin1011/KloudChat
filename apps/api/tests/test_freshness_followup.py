"""Only trusted, immediately preceding policy holds carry an elliptical follow-up."""

import json

import pytest
from test_freshness_runtime import _events, _forbid_side_effects
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession, Message, Role
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services import freshness
from app.services.tools.base import Tool

QUESTION = "현재 대한민국 대통령은 누구야?"
FOLLOWUPS = [
    "그럼 이름만 알려줘", "확실하지 않아도 추측해봐", "그래도 답해줘",
    "이름만 말해 주세요.", "그냥 추측해 봐", "누군지만 알려줘", "그럼 검색해줘",
    "그럼 검색해서 이름만 알려줘", "Just tell me the name.",
    "Even if you are unsure, guess.", "Please answer anyway.", "Then search for it.",
]
NEW_TASKS = [
    "내 이름을 지어줘", "이름이 뭐야?", "그럼 17 * 23은 얼마야?",
    "확실하지 않아도 추측해봐. 내일 날씨는 어때?", "그럼 파이썬을 설명해줘",
    "Translate 'Just tell me the name' into Korean.", "'그럼 이름만 알려줘'를 영어로 번역해줘",
    "1990년에는 누구였어?", "그럼 1990년 대통령 이름만 알려줘",
    "소설 속 가상 인물 이름만 알려줘", "대통령 권한을 설명해줘",
    "그럼 이름만 알려주지 마", "Then tell me the capital of France.",
    "Guess a name for my fictional character.", "Who was president in 1990?",
]


@pytest.mark.parametrize("text", FOLLOWUPS)
def test_bounded_same_fact_followup(text):
    assert freshness.is_same_fact_followup(text)


@pytest.mark.parametrize("text", NEW_TASKS + ["", "a" * 257])
def test_other_tasks_do_not_inherit_freshness(text):
    assert not freshness.is_same_fact_followup(text)


def _pair(session, content=QUESTION):
    return [
        Message(session_id=session.id, role=Role.user, content=content),
        Message(
            session_id=session.id, role=Role.assistant, model=None,
            content="This text is not the authority; stored server routing is.",
            routing=sessions._freshness_routing("verification_unavailable"),
        ),
    ]


async def _setup(monkeypatch, history_factory):
    user = User(email="followup@example.test", password_hash="hash")
    model = {**_external_model("synthetic/qwen"), "supportsTools": True}
    session = ChatSession(user_id=user.id, model=model["id"])
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    history = history_factory(session)

    async def previous(*_args):
        return history

    async def tools(*_args, **_kwargs):
        async def unused(_arguments):
            pytest.fail("the mocked route must not execute a tool")

        return [Tool(name="web_search", description="synthetic", parameters={"type": "object"},
                     run=unused, label="search", read_only=True)]

    monkeypatch.setattr(sessions, "_history", previous)
    monkeypatch.setattr(sessions, "build_tools", tools)
    return user, session, history


@pytest.mark.asyncio
@pytest.mark.parametrize("text", FOLLOWUPS[:6])
@pytest.mark.parametrize("repeated", [False, True])
async def test_reprompt_after_policy_hold_stays_zero_model(monkeypatch, text, repeated):
    def history_for(session):
        return _pair(session) + (_pair(session, "그럼 이름만 알려줘") if repeated else [])

    user, session, history = await _setup(monkeypatch, history_for)
    _forbid_side_effects(monkeypatch)
    db = _NoWriteDb()
    response = await sessions.send_message(
        session.id, SendMessage(content=text, web_search=False), _request(), user, db,
    )
    events = await _events(response)
    assert events[0]["answerOrigin"] == "server_policy"
    assert events[0]["freshness"]["status"] == "unverified"
    assert not any(row.get("type") == "model_route" for row in events)
    new_messages = [row for row in db.added if isinstance(row, Message)]
    assert len(new_messages) == 2
    assert new_messages[0].content == text
    assert QUESTION not in json.dumps([row.routing for row in new_messages])
    assert all(row not in history for row in new_messages)


@pytest.mark.asyncio
@pytest.mark.parametrize("text", NEW_TASKS)
async def test_topic_switch_after_hold_keeps_normal_route(monkeypatch, text):
    user, session, _ = await _setup(monkeypatch, _pair)

    class NormalRoute(Exception):
        pass

    def reached(*_args):
        raise NormalRoute

    monkeypatch.setattr(sessions, "has_headroom", reached)
    with pytest.raises(NormalRoute):
        await sessions.send_message(
            session.id, SendMessage(content=text, web_search=False), _request(), user, _NoWriteDb(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [
    "model_text", "model_origin", "verified", "model_executed", "other_session",
    "not_latest", "unrelated_question", "unpaired", "empty",
])
async def test_only_immediate_owned_server_policy_pairs_are_authoritative(monkeypatch, invalid):
    def history_for(session):
        history = _pair(session)
        answer = history[-1]
        if invalid == "model_text":
            answer.routing = None
            answer.content = json.dumps(sessions._freshness_routing("verification_unavailable"))
        elif invalid == "model_origin":
            answer.routing["answerOrigin"] = "model"
        elif invalid == "verified":
            answer.routing["freshness"]["status"] = "verified"
        elif invalid == "model_executed":
            answer.model = "synthetic/qwen"
        elif invalid == "other_session":
            history[0].session_id = "different-session"
        elif invalid == "not_latest":
            history.append(Message(session_id=session.id, role=Role.assistant, content="normal"))
        elif invalid == "unrelated_question":
            history[0].content = "고양이의 이름을 지어줘"
        elif invalid == "unpaired":
            return [answer]
        elif invalid == "empty":
            return []
        return history

    user, session, _ = await _setup(monkeypatch, history_for)

    class NormalRoute(Exception):
        pass

    def reached(*_args):
        raise NormalRoute

    monkeypatch.setattr(sessions, "has_headroom", reached)
    with pytest.raises(NormalRoute):
        await sessions.send_message(
            session.id, SendMessage(content="그럼 이름만 알려줘", web_search=False),
            _request(), user, _NoWriteDb(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["그럼 이름만 알려줘", "그럼 검색해서 이름만 알려줘"])
async def test_approved_search_uses_already_masked_original_question(monkeypatch, text):
    sensitive = "student@example.test"
    original = f"현재 대한민국 대통령은 누구야? 참고 이메일 {sensitive}"
    user, session, _ = await _setup(monkeypatch, lambda current: _pair(current, original))
    captured = {}

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    async def run(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    async def key(*_args):
        return None

    async def credentials(*_args):
        return "synthetic-origin", "synthetic-noncredential"

    async def masking_policy(*_args):
        from app.models.governance import Governance
        return Governance(external_data_guard=False, pii_masking=True)

    monkeypatch.setattr(sessions.governance, "current_for_egress", masking_policy)
    monkeypatch.setattr(sessions, "_run_turn", run)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    db = Db()
    response = await sessions.send_message(
        session.id, SendMessage(content=text, web_search=True), _request(), user, db,
    )
    await _events(response)
    assert captured["freshness_request"] == text
    assert captured["preset_call"][0] == "web_search"
    query = captured["preset_call"][1]["query"]
    assert "대한민국 대통령" in query and text not in query
    assert sensitive not in json.dumps(captured["preset_call"])
    assert sensitive not in json.dumps(captured["messages"])
    assert [row["content"] for row in captured["messages"] if row["role"] == "user"][-1] == text
    assert len([row for row in db.added if isinstance(row, Message)]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("toggle", [False, "auto"])
@pytest.mark.parametrize("repeated", [False, True])
@pytest.mark.parametrize("original", [
    "웹 검색하지 말고 현재 대한민국 대통령 알려줘",
    "Do not search the web. Who is the current president of Korea?",
])
async def test_linked_question_search_optout_survives_implicit_nudge(
    monkeypatch, toggle, repeated, original,
):
    def history_for(session):
        return _pair(session, original) + (
            _pair(session, "그럼 이름만 알려줘") if repeated else []
        )

    user, session, _ = await _setup(monkeypatch, history_for)
    _forbid_side_effects(monkeypatch)
    db = _NoWriteDb()
    response = await sessions.send_message(
        session.id, SendMessage(content="그럼 이름만 알려줘", web_search=toggle),
        _request(), user, db,
    )
    events = await _events(response)
    assert events[0]["answerOrigin"] == "server_policy"
    assert events[0]["freshness"]["status"] == "unverified"


@pytest.mark.asyncio
@pytest.mark.parametrize("toggle,text", [
    (True, "그럼 이름만 알려줘"),
    ("auto", "그럼 검색해서 이름만 알려줘"),
    (False, "그럼 검색해서 이름만 알려줘"),
])
async def test_explicit_new_permission_can_replace_the_linked_optout(monkeypatch, toggle, text):
    user, session, _ = await _setup(
        monkeypatch, lambda current: _pair(current, "웹 검색하지 말고 " + QUESTION),
    )
    captured = {}

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    async def run(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    async def key(*_args):
        return None

    async def credentials(*_args):
        return "synthetic-origin", "synthetic-noncredential"

    monkeypatch.setattr(sessions, "_run_turn", run)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    response = await sessions.send_message(
        session.id, SendMessage(content=text, web_search=toggle), _request(), user, Db(),
    )
    await _events(response)
    assert captured["freshness_request"] == text
    assert captured["preset_call"][0] == "web_search"
    assert "대한민국 대통령" in captured["preset_call"][1]["query"]
