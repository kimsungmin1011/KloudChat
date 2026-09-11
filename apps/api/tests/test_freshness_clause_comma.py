"""A declined topic cannot swallow an explicit current fact after a comma."""

import pytest
from test_freshness_followup import _setup
from test_freshness_runtime import _events, _forbid_side_effects
from test_privacy import _NoWriteDb, _request

from app.models.chat import Message, Role
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.freshness import fresh_fact_required


@pytest.mark.parametrize("boundary", [", ", ",", "， ", " ，"])
@pytest.mark.parametrize("live", ["현재", "지금"])
def test_declined_first_fact_keeps_current_question_after_comma(boundary, live):
    question = f"대통령 이름은 말하지 말고{boundary}{live} 국무총리가 누구인지 알려줘."
    assert fresh_fact_required(question)


@pytest.mark.parametrize("question", [
    "대통령 이름은 말하지 말고, 파이썬 리스트를 설명해줘.",
    "현재 대통령이 누구인지 말하지 말고, 지금 국무총리의 권한만 설명해줘.",
    "대통령 이름은 말하지 말고，현재 총리의 역할만 설명해줘.",
    "현재 대통령 질문은 그만하고, 지금 파이썬 리스트를 설명해줘.",
    "1990년 당시 대한민국 대통령은 누구였어?",
    "현재가 아니라 1990년 당시 국무총리가 누구인지 알려줘.",
    "'대통령 이름은 말하지 말고, 현재 국무총리가 누구인지 알려줘.'를 영어로 번역해줘.",
    'Translate "Do not name the president, tell me who the current prime minister is" '
    "into Korean.",
])
def test_comma_boundary_preserves_non_current_fact_tasks(question):
    assert not fresh_fact_required(question)


@pytest.mark.parametrize("question", [
    "대통령 이름은 말하지 말고 현재 국무총리가 누구인지 알려줘.",
    "대통령 이름을 알려주고, 현재 총리의 역할만 설명해줘.",
])
def test_existing_whitespace_and_earlier_affirmative_requests_stay_guarded(question):
    assert fresh_fact_required(question)


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", [", ", "，"])
@pytest.mark.parametrize("live", ["현재", "지금"])
async def test_comma_mixed_request_holds_before_model_and_quota(monkeypatch, boundary, live):
    user, session, _ = await _setup(monkeypatch, lambda _session: [])
    _forbid_side_effects(monkeypatch)
    question = f"대통령 이름은 말하지 말고{boundary}{live} 국무총리가 누구인지 알려줘."
    db = _NoWriteDb()
    response = await sessions.send_message(
        session.id, SendMessage(content=question, web_search=False), _request(), user, db,
    )
    events = await _events(response)
    messages = [row for row in db.added if isinstance(row, Message)]
    assert len(messages) == 2
    assert messages[0].role == Role.user
    assert messages[0].content == question
    answer = messages[1]
    assert answer.role == Role.assistant
    assert answer.model is None
    assert answer.usage == {"inputTokens": 0, "outputTokens": 0, "credits": 0}
    assert not answer.artifact_ids
    assert events[0] == {"type": "freshness_abstention", **answer.routing}
    assert events[0]["answerOrigin"] == "server_policy"
    assert events[0]["actualModel"] is None
    assert not any(event["type"] == "model_route" for event in events)
    assert db.commits == 1
