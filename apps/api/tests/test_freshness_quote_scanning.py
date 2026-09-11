"""Quoted source exemptions preserve complete requests and bounded scan work."""

import subprocess
import sys

import pytest

from app.services import context
from app.services.freshness import fresh_fact_required, without_quoted_transform_sources


@pytest.mark.parametrize(
    "opening,closing", [('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"), ("「", "」")]
)
@pytest.mark.parametrize("spacing", ["", " ", "\t\n", "\u2003" * 30])
def test_quoted_translation_and_later_question_keep_separate_meanings(opening, closing, spacing):
    source = f"{opening}Who is the current president?{closing}"
    request = f"Translate{spacing}:{spacing}{source}"
    assert without_quoted_transform_sources(request) == f"Translate{spacing}:{spacing} "
    assert not fresh_fact_required(request)
    assert fresh_fact_required(request + " Also, who is the current prime minister?")
    assert context.declines_web_search(request + " Do not search.")


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ('Translate "first\nsecond"', "Translate  "),
        ("Translate 'first\nsecond'", "Translate 'first\nsecond'"),
        ("Translate 'first\rsecond'", "Translate  "),
        ("Translate “first\nsecond”", "Translate  "),
        ("Translate 「first\nsecond」", "Translate  "),
        ("Translate “first'second'”", "Translate  "),
        ("Translate “first“second”", "Translate  "),
        ('“unclosed Translate "source"', "“unclosed Translate  "),
        ("'unclosed\nTranslate 'source'", "'unclosed\nTranslate  "),
        ('Translate "source" and Translate 「other」', "Translate   and Translate  "),
        (
            'Do not translate "Who is the current president?"',
            'Do not translate "Who is the current president?"',
        ),
        (
            'Translate:: "Who is the current president?"',
            'Translate:: "Who is the current president?"',
        ),
        ('다음 문장을 번역해 주세요 \t:  "source"', "다음 문장을 번역해 주세요 \t:   "),
        (
            '"현재 대통령은 누구야?"를 번역하지 말고 답해줘',
            '"현재 대통령은 누구야?"를 번역하지 말고 답해줘',
        ),
    ],
)
def test_quote_pairing_newlines_negation_and_prefix_whitespace_are_preserved(prompt, expected):
    assert without_quoted_transform_sources(prompt) == expected


def test_long_unmatched_quote_inputs_finish_without_dropping_the_suffix():
    # A subprocess bounds a regression without hanging the API test runner.
    script = """
from app.services import context
from app.services.freshness import fresh_fact_required, without_quoted_transform_sources
for opening in ('“', '‘', '「'):
    text = opening * 190000 + ' Do not search. Who is the current president?'
    assert without_quoted_transform_sources(text) == text
    assert fresh_fact_required(text)
    assert context.declines_web_search(text)
"""
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, timeout=5)
