"""A contraction before a quoted transformation source is not a quote opener."""

import subprocess
import sys

import pytest
from test_freshness_runtime import _events
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services import context
from app.services.freshness import fresh_fact_required, without_quoted_transform_sources

TRANSLATION = "Don't search. Translate 'Who is the current president of Korea?' into Korean."


def test_search_opt_out_contraction_does_not_steal_the_source_opening_quote():
    assert without_quoted_transform_sources(TRANSLATION) == "Don't search. Translate   into Korean."
    assert not fresh_fact_required(TRANSLATION)
    assert context.declines_web_search(TRANSLATION)


@pytest.mark.parametrize(
    "opening,closing", [('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"), ("「", "」")]
)
def test_prefix_contraction_preserves_each_supported_quote_pair(opening, closing):
    source = f"{opening}Who is the current president?{closing}"
    request = f"Don't search. Translate {source} into Korean."
    assert without_quoted_transform_sources(request) == "Don't search. Translate   into Korean."
    assert not fresh_fact_required(request)
    assert fresh_fact_required(request + " Also, who is the current prime minister?")


@pytest.mark.parametrize(
    "prompt",
    [
        "Don't translate 'Who is the current president of Korea?'; answer the question.",
        TRANSLATION + " Also, who is the current president of Korea?",
        "Don't search. Who is the current president of Korea?",
        "Don't search. 'Who is the current president of Korea?' Answer that question.",
        "Translate 'hello'and who is the current president? 'Other'",
        "Don't search. Translate 'hello'and who is the current president? 'Other'",
    ],
)
def test_contractions_do_not_exempt_a_real_question_or_negated_transform(prompt):
    assert fresh_fact_required(prompt)


def test_long_contraction_prefix_keeps_the_complete_mixed_request_and_finishes():
    script = """
from app.services.freshness import fresh_fact_required, without_quoted_transform_sources
prefix = "Don't search. " * 17000
text = prefix + "Translate 'Who is the current president?' into Korean."
assert without_quoted_transform_sources(text) == prefix + "Translate   into Korean."
assert not fresh_fact_required(text)
assert fresh_fact_required(text + " Also, who is the current prime minister?")
"""
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, timeout=5)


@pytest.mark.asyncio
async def test_translation_with_search_opt_out_reaches_normal_chat_without_freshness_hold(
    monkeypatch,
):
    user = User(email="synthetic@example.test", password_hash="hash", name="Synthetic")
    model = {**_external_model("synthetic/qwen"), "supportsTools": True}
    session = ChatSession(user_id=user.id, model=model["id"])
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])
    captured = {}

    async def ensure_key(*_args, **_kwargs):
        return None

    async def credentials(*_args, **_kwargs):
        return "http://fixture.invalid", "synthetic-only"

    async def no_tools(*_args, **_kwargs):
        return []

    async def streamed_answer():
        yield sessions.chat_service.sse({"type": "delta", "text": "SYNTHETIC_TRANSLATION"})
        yield sessions.chat_service.sse({"type": "done"})

    def run_turn(**kwargs):
        captured.update(kwargs)
        return streamed_answer()

    class AcceptedDb(_NoWriteDb):
        def is_modified(self, _value):
            return False

    monkeypatch.setattr(sessions, "has_headroom", lambda *_args: True)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", ensure_key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions, "build_tools", no_tools)
    monkeypatch.setattr(sessions, "_run_turn", run_turn)
    response = await sessions.send_message(
        session.id, SendMessage(content=TRANSLATION, web_search=False),
        _request(), user, AcceptedDb(),
    )
    events = await _events(response)
    assert [event["type"] for event in events] == ["delta", "done"]
    assert events[0]["text"] == "SYNTHETIC_TRANSLATION"
    assert captured["model"]["id"] == model["id"]
    assert captured.get("freshness_request") is None
    user_messages = [m["content"] for m in captured["messages"] if m["role"] == "user"]
    assert user_messages == [TRANSLATION]
