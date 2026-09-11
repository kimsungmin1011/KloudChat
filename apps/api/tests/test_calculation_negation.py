"""A negated arithmetic operation is not permission to require that operation."""

import pytest
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.calculation_policy import requires_calculation


@pytest.mark.parametrize("verb", ["더하지", "곱하지", "나누지", "더해 주지"])
def test_negating_the_numeric_operation_does_not_force_calculation(verb):
    for left, right in [(5, 9), (-7, 13), (1200, 3400)]:
        assert not requires_calculation(
            f"{left}와 {right}를 {verb} 말고 그대로 적어 줘."
        )


@pytest.mark.parametrize(
    "question",
    [
        "5와 9를 더하지 말고 대신 곱해 줘.",
        "5와 9를 곱하지 말고 더해 줘.",
        "5와 9를 더하지 않고 대신 곱해 줘.",
        "5와 9를 더하지 말고 그대로 적어 줘. 그리고 7에 3을 곱해 줘.",
    ],
)
def test_an_explicit_replacement_or_later_calculation_remains_required(question):
    assert requires_calculation(question)


def test_a_negated_replacement_does_not_restore_calculation():
    assert not requires_calculation("5와 9를 더하지 말고 곱하지도 마.")


def test_a_negated_operation_statement_does_not_force_calculation():
    assert not requires_calculation("5와 9를 더하지 않고 그대로 적어 줘.")


@pytest.mark.asyncio
@pytest.mark.parametrize("negation", ["말고", "않고"])
async def test_send_message_does_not_reject_a_non_calculation_on_a_tool_free_model(
    monkeypatch, negation,
):
    user = User(email="negation@example.test", password_hash="hash", name="Learner")
    model = {**_external_model("synthetic/tool-free"), "supportsTools": False}
    session = ChatSession(user_id=user.id, model=model["id"])
    await _patch_guard_dependencies(
        monkeypatch, session=session, models=[model], blocks=[],
    )

    class ReachedOrdinaryCreditCheck(Exception):
        pass

    def stop_before_any_write(*_args):
        raise ReachedOrdinaryCreditCheck

    db = _NoWriteDb()
    monkeypatch.setattr(sessions, "has_headroom", stop_before_any_write)
    with pytest.raises(ReachedOrdinaryCreditCheck):
        await sessions.send_message(
            session.id,
            SendMessage(content=f"5와 9를 더하지 {negation} 그대로 적어 줘.", web_search=False),
            _request(), user, db,
        )
    assert db.added == [] and db.commits == 0
