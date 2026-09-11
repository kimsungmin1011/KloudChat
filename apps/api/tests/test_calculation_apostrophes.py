"""Word apostrophes must not erase arithmetic refusals or quoted boundaries."""

import itertools
import re

import pytest
from test_privacy import _external_model, _NoWriteDb, _patch_guard_dependencies, _request

from app.models.chat import ChatSession
from app.models.user import User
from app.routers import sessions
from app.schemas.chat import SendMessage
from app.services import calculation_policy as policy


@pytest.mark.parametrize("question", [
    "Don't add 5 and 9. Don't multiply 2 by 3.",
    "Don't calculate 5 + 9. Don't evaluate 2 * 3.",
    "Don’t add 5 and 9. Don’t multiply 2 by 3.",
    "Alice's note: Don't add 5 and 9. Don't multiply 2 by 3.",
    "James' note: Don't add 5 and 9. Don't multiply 2 by 3.",
    "Don't add 5 and 9. 2와 3을 곱하지 마.",
    "5와 9를 더하지 마. Don't multiply 2 by 3.",
    "'Don't add 5 and 9. Then multiply 2 by 3'라는 문구를 설명해 줘.",
    "‘Don’t add 5 and 9. Then multiply 2 by 3’라는 문구를 설명해 줘.",
    "'calculate 2 + 3'이라는 문구를 설명해 줘.",
    "'multiply'라는 단어와 5, 9를 설명해 줘.",
])
def test_word_apostrophes_and_quoted_commands_do_not_force_arithmetic(question):
    assert not policy.requires_calculation(question)


@pytest.mark.parametrize("question", [
    "Don't add 5 and 9. Don't multiply 2 by 3. Then calculate 6 + 7.",
    "Don’t add 5 and 9. Also multiply 6 by 7.",
    "Alice's numbers are 5 and 9. Calculate their sum.",
    "James' numbers are 5 and 9. Calculate their sum.",
    "Don't add 5 and 9. 그리고 6과 7을 곱해 줘.",
    "5와 9를 더하지 마. Then multiply 6 by 7.",
    "'12 + 3'을 계산해 줘.",
    "‘12 + 3’을 계산해 줘.",
    '“12 + 3”을 계산해 줘.',
    '"12 + 3"을 계산해 줘.',
    "'Don't add 5 and 9'라는 문구를 설명해 줘. Then calculate 6 + 7.",
    "Don't add 5 and 9. " + "x " * 7000 + ". Then multiply 6 by 7.",
])
def test_quotes_still_supply_numbers_and_later_calculation_is_not_lost(question):
    assert policy.requires_calculation(question)


@pytest.mark.asyncio
async def test_send_message_does_not_409_on_two_contracted_refusals(monkeypatch):
    user = User(email="apostrophe@example.test", password_hash="hash")
    model = {**_external_model("synthetic/tool-free"), "supportsTools": False}
    session = ChatSession(user_id=user.id, model=model["id"])
    await _patch_guard_dependencies(monkeypatch, session=session, models=[model], blocks=[])

    class OrdinaryRoute(Exception):
        pass

    def reached(*_args):
        raise OrdinaryRoute

    monkeypatch.setattr(sessions, "has_headroom", reached)
    db = _NoWriteDb()
    with pytest.raises(OrdinaryRoute):
        await sessions.send_message(
            session.id,
            SendMessage(content="Don't add 5 and 9. Don't multiply 2 by 3."),
            _request(), user, db,
        )
    assert db.added == [] and db.commits == 0


def test_quote_masking_retains_legacy_classes_first_close_and_newline_rules():
    old = re.compile(r'''"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’''')
    atoms = ["plain ", "' ", '" ', "‘ ", "’ ", "“ ", "” ", "\n"]
    for parts in itertools.product(atoms, repeat=4):
        text = "".join(parts)
        expected = old.sub(lambda match: " " * len(match.group()), text)
        assert policy._mask_quoted_intent(text) == expected, repr(text)


@pytest.mark.parametrize("text,expected", [
    ("'don't multiply 2 by 3'이라는", " " * 23 + "이라는"),
    ("'multiply'라는", " " * 10 + "라는"),
    ("'calculate 2 + 3'이라는", " " * 17 + "이라는"),
    ("don't", "don't"),
    ("Alice's", "Alice's"),
    ("James' note", "James' note"),
])
def test_apostrophe_boundaries_keep_mask_offsets(text, expected):
    assert policy._mask_quoted_intent(text) == expected


def test_unclosed_quote_prefix_does_not_discard_the_request_suffix():
    text = "‘" * 15000 + "\nThen multiply 6 by 7."
    assert policy._mask_quoted_intent(text) == text
    assert policy.requires_calculation(text)
