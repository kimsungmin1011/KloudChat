"""A year-qualified present is historical only after that year has ended."""

import json
from datetime import UTC, date, datetime

import pytest
from fastapi.responses import StreamingResponse
from test_freshness_runtime import _events, _forbid_side_effects
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession, Message, Role, RoutingMode
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.freshness import fresh_fact_required


@pytest.mark.parametrize("reference_year", [2025, 2026, 2027])
@pytest.mark.parametrize("offset,expected", [(-2, False), (-1, False), (0, True), (1, True)])
@pytest.mark.parametrize("subject", ["대한민국 대통령은 누구야?", "한국 정치 상황을 알려줘."])
def test_year_qualified_present_tracks_the_calendar(reference_year, offset, expected, subject):
    prompt = f"{reference_year + offset}년 현재 {subject}"
    assert fresh_fact_required(prompt, as_of=date(reference_year, 9, 12)) is expected


@pytest.mark.parametrize(
    "prompt",
    [
        "'{year}년 현재 대한민국 대통령은 누구야?'를 영어로 번역해줘",
        "다음 자료만 요약해줘: {year}년 현재 정국은 복잡하다.",
        "{year}년 현재 가상 국가에서 대통령은 누구인지 설정해줘",
        "{year}년 현재 대통령의 권한과 의무를 설명해줘",
        "{year}년 현재가 아니라 1980년 당시 대통령은 누구였어?",
    ],
)
def test_dated_present_preserves_nonfactual_exceptions(prompt):
    assert not fresh_fact_required(prompt.format(year=2026), as_of=date(2026, 9, 12))


def test_completed_year_changes_at_the_calendar_boundary():
    prompt = "2026년 현재 대한민국 대통령은 누구야?"
    assert fresh_fact_required(prompt, as_of=date(2026, 12, 31))
    assert not fresh_fact_required(prompt, as_of=date(2027, 1, 1))


@pytest.mark.parametrize(
    "prompt",
    [
        "2020년 현재 대통령과 지금 대한민국 대통령은 누구야?",
        "2020년 현재 대통령은 누구야? 그리고 2026년 현재 총리는 누구야?",
        "12020년 현재 대한민국 대통령은 누구야?",
    ],
)
def test_dated_snapshot_does_not_hide_another_present_request(prompt):
    assert fresh_fact_required(prompt, as_of=date(2026, 9, 12))


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(RoutingMode))
async def test_current_year_request_holds_before_key_model_or_accounting(monkeypatch, mode):
    user = User(email="synthetic@example.test", password_hash="hash", name="Synthetic")
    model = {**_external_model("synthetic/qwen"), "supportsTools": True}
    session = ChatSession(user_id=user.id, model=model["id"], routing_mode=mode)
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    _forbid_side_effects(monkeypatch)

    async def no_tools(*_args, **_kwargs):
        return []

    monkeypatch.setattr(sessions, "build_tools", no_tools)
    db = _NoWriteDb()
    year = datetime.now(UTC).year
    response = await sessions.send_message(
        session.id,
        SendMessage(content=f"{year}년 현재 대한민국 대통령은 누구야?", web_search=False),
        _request(), user, db,
    )
    assert isinstance(response, StreamingResponse)
    events = await _events(response)
    assert events[0]["type"] == "freshness_abstention"
    answers = [row for row in db.added if isinstance(row, Message) and row.role == Role.assistant]
    assert len(answers) == 1
    assert answers[0].model is None
    assert answers[0].routing["answerOrigin"] == "server_policy"
    assert answers[0].usage == {"inputTokens": 0, "outputTokens": 0, "credits": 0}
    assert "synthetic/qwen" not in json.dumps(events)
