"""Compatibility normalization must not invent a different numeric expression."""

import pytest
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services.calculation_policy import direct_calculation_expression
from app.services.tools.arithmetic import CALCULATE


@pytest.mark.parametrize(
    "question",
    ["2² + 3²은 얼마야?", "10⁻² + 1", "2₁ + 3₂", "1½ + 2"],
)
def test_non_positional_numeric_notation_is_not_copied_as_a_literal(question):
    assert direct_calculation_expression(question) is None


def test_replacing_operands_preserves_supported_width_and_operator_normalizations():
    fullwidth = str.maketrans("0123456789", "０１２３４５６７８９")
    for left, right in [(2, 3), (7, 11), (19, 41)]:
        question = f"−{left} × ({right} + .5) ÷ 2은 얼마야?"
        expected = f"-{left} * ({right} + .5) / 2"
        assert direct_calculation_expression(question) == expected
        assert direct_calculation_expression(question.translate(fullwidth)) == expected


@pytest.mark.asyncio
async def test_send_message_does_not_preselect_a_reinterpreted_superscript_expression(monkeypatch):
    user = User(email="notation@example.test", password_hash="hash", name="Learner")
    model = {**_external_model("synthetic/quality"), "supportsTools": True}
    session = ChatSession(user_id=user.id, model=model["id"])
    await _patch_guard_dependencies(
        monkeypatch, session=session, models=[model], blocks=[],
    )
    captured = {}

    async def tools(*_args, **_kwargs):
        return [CALCULATE]

    async def key(*_args, **_kwargs):
        return "synthetic-unused-key"

    async def credentials(*_args, **_kwargs):
        return "http://unused.test", "synthetic-unused-key"

    async def stream(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    monkeypatch.setattr(sessions, "build_tools", tools)
    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions, "_run_turn", stream)
    response = await sessions.send_message(
        session.id, SendMessage(content="2² + 3²은 얼마야?", web_search=False),
        _request(), user, Db(),
    )
    _ = [part async for part in response.body_iterator]
    assert captured["calculation_expression"] is None
    assert captured["calculation_required"] is True
    assert captured["preflight_tool"] == "calculate"
    assert captured["tools"] == [CALCULATE]
    assert captured["model"]["id"] == model["id"]
    assert captured["messages"][-1] == {"role": "user", "content": "2² + 3²은 얼마야?"}
