"""Tool-free comparison retains only trusted, same-session current-fact holds."""

import json
from copy import deepcopy

import pytest
from fastapi.responses import JSONResponse
from test_freshness_followup import QUESTION, _pair
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession, Message, Role
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import CompareRequest


@pytest.mark.asyncio
@pytest.mark.parametrize("question,held,state", [
    (QUESTION, True, "held"),
    (QUESTION, True, "attachment"),
    ("그럼 이름만 알려줘", True, "held"),
    ("확실하지 않아도 추측해봐", True, "held"),
    ("Just tell me the name.", True, "held"),
    ("그럼 이름만 알려줘", True, "repeated"),
    ("그럼 이름만 알려줘", True, "prior_optout"),
    ("그럼 검색해서 이름만 알려줘", True, "prior_optout"),
    ("그럼 검색해서 이름만 알려줘", True, "held"),
    ("그럼 17 * 23은 얼마야?", False, "held"),
    ("1990년 대통령은 누구였어?", False, "held"),
    ("Translate 'Just tell me the name' into Korean.", False, "held"),
    ("그럼 이름만 알려줘", False, "attachment"),
    ("그럼 이름만 알려줘", False, "model_origin"),
    ("그럼 이름만 알려줘", False, "model_executed"),
    ("그럼 이름만 알려줘", False, "model_text"),
    ("그럼 이름만 알려줘", False, "other_session"),
    ("그럼 이름만 알려줘", False, "not_latest"),
    ("그럼 이름만 알려줘", False, "unrelated_question"),
    ("그럼 이름만 알려줘", False, "empty"),
])
async def test_comparison_retains_same_fact_hold_without_blocking_new_task(
    monkeypatch, question, held, state,
):
    user = User(email="review@example.test", password_hash="synthetic")
    models = [_external_model("synthetic/one"), _external_model("synthetic/two")]
    original_models = deepcopy(models)
    session = ChatSession(user_id=user.id, model=models[0]["id"])
    await _patch_guard_dependencies(monkeypatch, session=session, models=models, blocks=[])
    history = _pair(session)
    if state == "prior_optout":
        history[0].content = "웹 검색 없이 " + QUESTION
    elif state == "repeated":
        history += _pair(session, "그럼 이름만 알려줘")
    elif state == "model_origin":
        history[-1].routing["answerOrigin"] = "model"
    elif state == "model_executed":
        history[-1].model = models[0]["id"]
    elif state == "model_text":
        history[-1].content = json.dumps(history[-1].routing)
        history[-1].routing = None
    elif state == "other_session":
        history[0].session_id = "different-session"
    elif state == "not_latest":
        history += [Message(session_id=session.id, role=Role.assistant, content="New topic")]
    elif state == "unrelated_question":
        history[0].content = "Suggest a name for a fictional character."
    elif state == "empty":
        history = []
    if held and question != QUESTION:
        assert sessions._freshness_followup_index(history, session.id, question) == 0

    async def previous(*_args):
        return history

    keys, credit_checks, captured = [], [], {}

    def headroom(*_args):
        credit_checks.append(True)
        return True

    async def attachments(_db, _user, identifiers):
        assert identifiers == ["synthetic-owned-file"]
        return [], []

    async def key(*_args):
        keys.append(True)

    async def credentials(*_args):
        return "http://unused.test", "synthetic-unused-key"

    async def compare(**kwargs):
        captured.update(kwargs)
        yield sessions.chat_service.sse({"type": "done"})

    class Db(_NoWriteDb):
        def is_modified(self, _row):
            return False

    monkeypatch.setattr(sessions, "_history", previous)
    monkeypatch.setattr(sessions, "has_headroom", headroom)
    monkeypatch.setattr(sessions.litellm_service, "ensure_key", key)
    monkeypatch.setattr(sessions.litellm_service, "credentials_for", credentials)
    monkeypatch.setattr(sessions, "_run_comparison", compare)
    if state == "attachment":
        monkeypatch.setattr(sessions, "_owned_attachments", attachments)
    db = Db()
    response = await sessions.compare_models(
        session.id, CompareRequest(
            content=question, models=[m["id"] for m in models],
            attachments=["synthetic-owned-file"] if state == "attachment" else None,
        ),
        _request(), user, db,
    )
    if not isinstance(response, JSONResponse):
        _ = [part async for part in response.body_iterator]
    if held:
        assert response.status_code == 409, {
            "comparison_started": bool(captured), "key_provisioning_attempted": bool(keys),
            "db_commits": db.commits,
            "guarded_original_question_in_model_context": QUESTION in json.dumps(
                captured.get("messages", []), ensure_ascii=False,
            ),
        }
        assert db.added == [] and db.commits == 0 and keys == [] and captured == {}
        assert credit_checks == []
        assert json.loads(response.body)["detail"] == "freshness_verification_unavailable"
    else:
        assert response.status_code == 200 and captured
        assert [model["id"] for model in captured["models"]] == [model["id"] for model in models]
    assert models == original_models
    assert session.model == models[0]["id"]
