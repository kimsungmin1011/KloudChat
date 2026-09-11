"""A narrow current-political-fact gate, independent of model or search settings.

Detects direct officeholder questions and explicitly current political developments
in Korean/English. This is not a general hallucination detector: other domains,
general implicit follow-ups, and every natural-language paraphrase are outside its contract.
It neither checks sources nor treats a supplied document as verified current evidence.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from datetime import UTC, date, datetime

FRESHNESS_INSTRUCTION = (
    "The system date does not prove that your knowledge is current. Never invent a training "
    "cutoff. For current officeholders and political developments, distinguish verified "
    "current evidence from memory, historical facts, fictional settings, and supplied text. "
    "Without current evidence, state that you cannot verify the present fact; do not guess."
)

_LIVE = re.compile(
    r"현재|지금|현직|요즘|오늘|최근|최신|이번|현\s*(?:대통령|총리|정부)|"
    r"\b(?:current(?:ly)?|now|today|latest|recent|incumbent|present)\b",
    re.I,
)
_OFFICE = re.compile(
    r"대통령(?!제)|국무총리|총리|국회의장|(?:서울|부산|인천|대구|대전|광주|울산)\s*시장|"
    r"\b(?:president|prime\s+minister|mayor|governor)\b",
    re.I,
)
_IDENTITY = re.compile(r"누구|누군지|누군가요|누가|성명|이름|\b(?:who|name|identity)\b", re.I)
_ASK = re.compile(
    r"알려|말해|어때|어떤|어디|무슨|인가|입니까|이야|정리|설명|결과|"
    r"\b(?:what|which|is|are|tell|describe|explain|summarize)\b",
    re.I,
)
_POLITICS = re.compile(
    r"정치\s*(?:상황|현황|동향|소식)|정국|여당|야당|정권|내각|탄핵|대선|총선|국회|"
    r"선거\s*(?:결과|상황)|\b(?:political\s+(?:situation|developments|news)|"
    r"ruling\s+party|opposition\s+party|presidential\s+election|election\s+results|"
    r"parliament|cabinet|impeachment)\b",
    re.I,
)
_HISTORICAL = re.compile(
    r"당시|과거|전직|역대|초대|제\s*\d+\s*대|누구였|이었|였어|"
    r"(?:1\d{3}|20\d{2})\s*년|\b(?:was|were|former|previous|historical|"
    r"in\s+(?:the\s+year\s+)?(?:1\d{3}|20\d{2}))\b",
    re.I,
)
_ROLE = re.compile(
    r"권한|의무|역할|직무|제도|장단점|\b(?:powers|duties|role|responsibilities)\b",
    re.I,
)
_ELIGIBILITY = re.compile(r"\bwho\s+can\s+(?:become|be)\s+(?:a\s+)?president\b", re.I)
_FICTION = re.compile(
    r"소설\s*속\s*(?:현직\s*)?(?:대통령|총리)|가상\s*(?:국가|나라|세계)|"
    r"(?:대통령|총리)(?:은|는|이|가)?\s*가상\s*인물|허구의\s*(?:대통령|총리)|"
    r"\b(?:fictional\s+(?:current\s+)?(?:country|president|leader)|in\s+my\s+novel)\b",
    re.I,
)
_CREATIVE = re.compile(r"만들|설정|써|가정|\b(?:imagine|write|invent|fictional)\b", re.I)
_REAL = re.compile(
    r"실제로|실제\s*(?:현재|지금|대한민국|한국)|\b(?:actually|real[- ]world)\b", re.I
)
_QUOTE_PAIRS = {'"': '"', "'": "'", "“": "”", "‘": "’", "「": "」"}
# Only a bounded quoted source is removed, never the rest of a mixed request.
_TRANSFORM_BEFORE = re.compile(
    r"(?:\btranslate(?:\s+(?:this|the\s+following)(?:\s+(?:sentence|text))?)?"
    r"(?:\s+(?:into|to)\s+[a-z-]{2,30})?|"
    r"\bsummarize(?:\s+only)?(?:\s+this\s+supplied\s+text)?|"
    r"다음\s*(?:문장|자료|글)(?:만|을|를)?\s*"
    r"(?:(?:한국어|영어|한글|영문)로\s*)?(?:번역|요약)해\s*(?:줘|주세요))$",
    re.I,
)
_TRANSFORM_AFTER = re.compile(
    r"^\s*(?:(?:라는|이라는)\s*문장(?:의|을)|[을를])\s*"
    r"(?:(?:한국어|영어|한글|영문)(?:로)?\s*)?(?:번역|요약|문법)",
    re.I,
)
_CLAUSE = re.compile(
    r"[.!?;\n]|\b(?:and|but|also)\b|그리고|하지만|그런데|(?:와|과)\s+|"
    r"(?:고\s+|(?<=고)\s*[,，]\s*)(?=현재|지금|실제|대한민국|한국|국무총리|대통령|총리)",
    re.I,
)
_SUPPLIED_TEXT = re.compile(
    r"(?:다음\s*(?:자료|글|문장)만\s*요약해\s*줘|"
    r"summarize\s+only\s+this\s+supplied\s+text)\s*:",
    re.I,
)
_DATED_PRESENT = re.compile(r"(?<!\d)((1\d{3}|20\d{2})\s*년)\s*현재")
_NEGATED_PRESENT = re.compile(r"(?:현재|지금|현직)(?:가|이)?\s*아니라")
_DECLINED_FACT = re.compile(
    r"(?:말|답|설명)하지\s*(?:마|말)|알려\s*주지\s*(?:마|말)|"
    r"^\s*(?:please\s+)?(?:do\s+not|don't|never)\s+(?:tell|name|identify|answer|say)\b",
    re.I,
)
_AFFIRMATIVE_REQUEST = re.compile(r"알려|말해|답해|누구(?:야|인가|입니까)")
_DECLINED_TOPIC = re.compile(
    r"(?:질문|설명|이야기|얘기|논의)(?:은|는|을|를)?\s*"
    r"(?:그만(?:하|두)고|하지\s*말고)"
)
_NEGATED_TRANSFORM_PREFIX = re.compile(r"\b(?:do\s+not|don't|never)\s*$", re.I)
_NEGATED_TRANSFORM_SUFFIX = re.compile(r"^\s*하지\s*(?:마|말)")
_DIRECT_REQUEST = re.compile(
    r"알려|말해|설명해|정리해|누구|누군지|누군가요|누가|어때|어떤|어디|무슨|인가|입니까|"
    r"\b(?:who|what|which|tell|describe|explain)\b|^(?:is|are)\b",
    re.I,
)
_SAME_FACT_FOLLOWUP = re.compile(
    r"(?:(?:그럼|그러면|그래도|그냥)\s*)?"
    r"(?:(?:확실하지\s*않아도|불확실해도)\s*[,，]?\s*)?"
    r"(?:검색해서\s*)?"
    r"(?:(?:(?:이름|성명|답|정답)(?:만|을)?|누군지(?:만)?)\s*)?"
    r"(?:알려\s*(?:줘|주세요)|말해\s*(?:줘|주세요)|답해\s*(?:줘|주세요)|"
    r"추측해\s*(?:봐|줘|주세요)|검색해\s*(?:줘|주세요))|"
    r"(?:(?:then|just|please|still)\s+)?"
    r"(?:even\s+if\s+(?:you\s+are\s+)?(?:unsure|uncertain)\s*,?\s*)?"
    r"(?:tell\s+me\s+(?:just\s+)?the\s+(?:name|answer)|"
    r"(?:answer|guess)(?:\s+anyway)?|search\s+for\s+(?:it|that))",
    re.I,
)


def is_same_fact_followup(request: str) -> bool:
    """Recognize only a short, whole-message nudge with no new named subject.

    This alone is never a freshness decision. The caller must also require an
    immediately preceding stored server-policy hold and its guarded user turn.
    """
    if not isinstance(request, str) or len(request) > 256:
        return False
    text = unicodedata.normalize("NFC", request).strip().rstrip(".!?。？！")
    return bool(_SAME_FACT_FOLLOWUP.fullmatch(text.strip()))


def _word_apostrophe(text: str, index: int) -> bool:
    """Do not treat an English contraction's apostrophe as an opening quote."""
    if text[index] != "'" or not 0 < index < len(text) - 1:
        return False
    before, after = text[index - 1], text[index + 1]
    return before.isascii() and before.isalpha() and after.isascii() and after.isalpha()


def _quoted_spans(text: str) -> Iterator[tuple[int, int]]:
    """Match the first closing delimiter without rescanning unmatched suffixes."""
    length = len(text)
    next_closing: dict[str, int] = {}
    next_newline = -1
    index = 0
    while index < length:
        closing = _QUOTE_PAIRS.get(text[index])
        if closing is None or _word_apostrophe(text, index):
            index += 1
            continue
        end = next_closing.get(closing, -1)
        if end <= index:
            found = text.find(closing, index + 1)
            end = found if found >= 0 else length
            next_closing[closing] = end
        if text[index] == "'":
            if next_newline <= index:
                found = text.find("\n", index + 1)
                next_newline = found if found >= 0 else length
            if next_newline < end:
                index += 1
                continue
        if end < length:
            yield index, end + 1
            index = end + 1
        else:
            index += 1


def without_quoted_transform_sources(text: str) -> str:
    """Remove only quoted translation/summary inputs, not quoted user instructions."""
    parts: list[str] = []
    start = 0
    for quote_start, quote_end in _quoted_spans(text):
        before = text[max(0, quote_start - 160) : quote_start]
        before = before.rstrip().removesuffix(":").rstrip()
        after = text[quote_end : quote_end + 160]
        parts.append(text[start:quote_start])
        before_match = _TRANSFORM_BEFORE.search(before)
        after_match = _TRANSFORM_AFTER.search(after)
        transforming = (
            before_match and not _NEGATED_TRANSFORM_PREFIX.search(before[: before_match.start()])
        ) or (after_match and not _NEGATED_TRANSFORM_SUFFIX.search(after[after_match.end() :]))
        parts.append(" " if transforming else text[quote_start:quote_end])
        start = quote_end
    parts.append(text[start:])
    return "".join(parts)


def fresh_fact_required(request: str, *, as_of: date | None = None) -> bool:
    """Whether this explicit political question needs current evidence before answering.

    Call with the latest user's request, not the assembled system/history/reference
    envelope. False means outside this bounded gate, never proven factually safe.
    """
    reference_year = (as_of or datetime.now(UTC).date()).year
    text = without_quoted_transform_sources(unicodedata.normalize("NFC", request or ""))
    supplied_text = False
    for part in _CLAUSE.split(text):
        clause = part.strip()
        if not clause:
            continue
        switched = _DECLINED_TOPIC.search(clause)
        if switched and not _AFFIRMATIVE_REQUEST.search(clause[: switched.start()]):
            # The discarded topic is not the new request. Keep the suffix so a
            # switch from president to current prime minister is still guarded.
            clause = clause[switched.end() :].strip()
            if not clause:
                continue
        supplied_header = _SUPPLIED_TEXT.search(clause)
        if supplied_header:
            # A leading search opt-out is not source text; keep any actual request
            # before the header, but do not reinterpret its inline source as a question.
            supplied_text = True
            clause = clause[: supplied_header.start()].strip()
            if not clause:
                continue
        elif supplied_text:
            # A later direct question is a new task, not a blanket summary exemption.
            if not _DIRECT_REQUEST.search(clause):
                continue
            supplied_text = False
        # "Tell me the name, do not explain the role" still asks for the present fact.
        declined = _DECLINED_FACT.search(clause)
        if _ELIGIBILITY.search(clause) or (
            declined and not _AFFIRMATIVE_REQUEST.search(clause[: declined.start()])
        ):
            continue
        # Only a completed year establishes a past snapshot; this year's date
        # is not evidence that model knowledge is current.
        dated = _DATED_PRESENT.sub(
            lambda match: match[1] if int(match[2]) < reference_year else match[0], clause
        )
        live = bool(_LIVE.search(_NEGATED_PRESENT.sub("", dated)))
        if not live and _HISTORICAL.search(clause):
            continue
        office_match = _OFFICE.search(clause)
        fiction = _FICTION.search(clause)
        if (
            fiction
            and _CREATIVE.search(clause)
            and not _REAL.search(clause)
            and (office_match is None or fiction.start() <= office_match.start())
        ):
            continue
        office = bool(office_match)
        identity = bool(_IDENTITY.search(clause))
        if office and identity:
            return True
        if office and live and not _ROLE.search(clause):
            # A bare topic ("현재 대한민국 대통령") is also an identity request.
            if _ASK.search(clause) or not re.search(r"[가-힣](?:다|요)$|\bis\s+.+", clause, re.I):
                return True
        if live and _POLITICS.search(clause):
            return True
    return False


def abstention_response(request: str) -> str:
    """An evidence limitation, not a claim that a search ran or the model is outdated."""
    if re.search(r"[가-힣]", unicodedata.normalize("NFC", request or "")):
        return (
            "현재 정보를 확인할 수 없어 현직 인물이나 정치 상황을 단정할 수 없습니다. "
            "최신 공식 자료를 제공하거나 검색을 허용한 환경에서 확인해 주세요."
        )
    return (
        "I cannot verify the current officeholder or political situation, so I cannot state "
        "it as a present fact. Provide a current official source or verify it in an "
        "environment where search is allowed."
    )
