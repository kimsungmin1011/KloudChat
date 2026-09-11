"""Supported English arithmetic commands also honor explicit negative commands."""

import pytest
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.calculation_policy import requires_calculation


@pytest.mark.parametrize(
    "operation", ["add 5 and 9", "subtract 9 from 15", "multiply 5 by 9", "divide 15 by 3"],
)
def test_supported_arithmetic_verbs_honor_negative_commands(operation):
    for prefix in ["Do not", "Don't", "Never"]:
        assert not requires_calculation(f"{prefix} {operation}. Keep the numbers unchanged.")


@pytest.mark.parametrize(
    "question",
    [
        "Do not add 5 and 9. Then multiply 6 by 7.",
        "Don't multiply 5 by 9. Also calculate 6 + 7.",
    ],
)
def test_a_separate_positive_calculation_is_not_blocked(question):
    assert requires_calculation(question)


@pytest.mark.asyncio
async def test_send_message_does_not_require_tools_for_a_negated_english_operation(monkeypatch):
    user = User(email="negative@example.test", password_hash="hash", name="Learner")
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
            SendMessage(
                content="Do not add 5 and 9. Keep the numbers unchanged.", web_search=False,
            ),
            _request(), user, db,
        )
    assert db.added == [] and db.commits == 0
