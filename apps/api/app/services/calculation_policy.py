"""Conservative request-only cues for a required arithmetic tool call.

This is not a semantic classifier: attachments, anaphoric follow-ups, spelled-out
numbers and requests over the bound remain outside this policy. The direct
extractor copies only an explicit expression; it never builds a word-problem
equation, evaluates arithmetic, or grants a tool permission.
"""

from __future__ import annotations

import ast
import re
import unicodedata

_MAX_REQUEST_CHARS = 16_384
_MAX_EXPRESSION_CHARS = 1_024
_NUMBER = re.compile(r"(?<![\w.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)", re.ASCII)
_FENCE = re.compile(r"```[\s\S]*?(?:```|\Z)")
_QUOTE_PAIRS = {'"': '"', "'": "'", "“": "”", "‘": "’"}
_QUOTE_ENDS = frozenset(_QUOTE_PAIRS.values())
_CLAUSE = re.compile(
    r"\n|[;!?]+|\.(?!\d)|\b(?:then|also|and)\b|그리고|또한|그다음|(?<=[고며]),?\s+",
    re.IGNORECASE,
)
_NEW_TASK = re.compile(r"(?:then|also|and|그리고|또한|그다음)\Z", re.IGNORECASE)
_TRANSFORM = re.compile(
    r"번역|그대로\s*출력|서식|쉼표로\s*연결|\b(?:translate|translation|paraphrase|format)\b",
    re.IGNORECASE,
)
_PROGRAM = re.compile(
    r"코드|파이썬|함수|프로그램|계산기|\b(?:code|python|function|script|ui|html|calculator)\b",
    re.IGNORECASE,
)
_BUILD = re.compile(r"만들|작성|구현|개발|\b(?:write|build|create|generate|implement)\b", re.I)
_CODE = re.compile(r"\b(?:function\s+\w+\s*\(|def\s+\w+\s*\(|return\s+)", re.I)
_DECLINE = re.compile(
    r"(?:계산|검산)(?:을)?\s*하지\s*(?:마|말)|"
    r"\b(?:do\s+not|don['’]t|never)\s+(?:calculate|compute|evaluate|add|subtract|multiply|divide)\b",
    re.IGNORECASE,
)
_MISSING = re.compile(
    r"(?:인원|조건|값|표|자료|정보|데이터|수치)[^.!?\n]{0,30}"
    r"(?:없[다어는음]|모르|부족|누락|미제공)|"
    r"\b(?:data|value|input|condition|size|table|number)[^.!?\n]{0,30}"
    r"\b(?:missing|unknown|unavailable|not\s+(?:provided|given|known))\b",
    re.IGNORECASE,
)
_CALCULATE = re.compile(r"계산|검산|산출|\b(?:calculate|compute|evaluate)\b", re.IGNORECASE)
_OPERAND = r"(?<![0-9A-Za-z_.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?![\d.])"
_QUANTITY = rf"{_OPERAND}\s*(?:원|점|명|개)?"
_ARITHMETIC_VERB = r"(?:더해|더하|빼\s*줘|빼면|곱하|곱해|곱하면|나누|나눠)"
_ARITHMETIC_ACTION = re.compile(
    rf"{_QUANTITY}\s*(?:와|과|에|에서|을|를)\s*{_QUANTITY}\s*(?:을|를|으로|로)?\s*"
    rf"{_ARITHMETIC_VERB}|"
    rf"\badd\s+(?:the\s+numbers?\s+)?{_OPERAND}"
    rf"(?:\s+(?:and|to|plus)\s+|\s*,\s*|\s+){_OPERAND}|"
    rf"\bsubtract\s+{_OPERAND}\s+from\s+{_OPERAND}|"
    rf"\b(?:multiply|divide)\s+{_OPERAND}\s+by\s+{_OPERAND}|"
    rf"{_OPERAND}\s+times\s+{_OPERAND}",
    re.IGNORECASE,
)
_NEGATED_ARITHMETIC = re.compile(r"^\s*(?:주)?지(?:는|도)?\s*(?:마|말|않)")
_REPLACEMENT_ARITHMETIC = re.compile(
    rf"^\s*(?:주)?지(?:는|도)?\s*(?:말고|않고)\s*(?:대신\s*)?{_ARITHMETIC_VERB}"
)
_EDITING_PREFIX = re.compile(r"(?:문단|예시|항목|제목|섹션|그룹|문서)\s*$")
_EDITING_SUFFIX = re.compile(r"^\s*(?:examples?|sections?|paragraphs?|items?|groups?)\b", re.I)
_TARGET = re.compile(
    r"가중\s*평균|평균|증가율|감소율|증감률|변화율|백분율|퍼센트|%|합계|총액|총합|"
    r"\b(?:mean|average|total|sum|percentage|percent|increase|decrease|growth)\b",
    re.IGNORECASE,
)
_ASK = re.compile(
    r"구해|구하|얼마|알려|계산|검산|산출|(?:평균|증가율|감소율|합계)[은는]?\s*[?？]|"
    r"\b(?:find|determine|calculate|compute|what\s+is|how\s+much|how\s+many)\b",
    re.IGNORECASE,
)
_CONVERT = re.compile(r"환산|변환|바꿔|\bconvert\b", re.IGNORECASE)
_UNIT = re.compile(
    r"킬로미터|센티미터|밀리미터|미터|킬로그램|밀리그램|그램|밀리리터|리터|"
    r"시간|분|초|(?<![a-z])(?:km/h|m/s|mm|cm|km|mg|kg|ml|ms|min|kb|mb|gb|m|g|l|s|h)(?![a-z])",
    re.IGNORECASE,
)
_PERCENT_CONVERSION = re.compile(r"백분율|퍼센트|소수|%|\b(?:percentage|percent|decimal)\b", re.I)
_DATE = re.compile(r"\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\Z")
_EXPRESSION_CHARS = re.compile(r"[0-9.()+\-*/\s]+\Z")
_EXPRESSION_PREFIX = re.compile(r"^(?:what\s+is|calculate|compute|evaluate)\s+", re.IGNORECASE)
_EXPRESSION_SUFFIX = re.compile(
    r"(?:[은는]?\s*얼마(?:야|인가|인가요)?|[을를]?\s*(?:계산|검산)해\s*줘)?[?.=\s]*$"
)
_DIRECT_LITERAL = re.compile(r"[0-9.()+\-*/ \t]+")
_DIRECT_CORE_SUFFIX = re.compile(
    r"(?:[은는]?\s*얼마(?:야|인가|인가요)?|"
    r"[을를]?\s*(?:계산|검산)해\s*(?:주세요|줘))?"
)
_DIRECT_FORMAT = re.compile(
    r"(?:(?:(?:계산식|식)(?:과|와)\s*(?:답|결과)만|(?:답|정답|결과)만)"
    r"\s*(?:짧게|간단히|간결하게)?\s*(?:(?:써|알려|보여|답해)\s*(?:주세요|줘))?|"
    r"(?:짧게|간단히|간결하게)\s*(?:답해|설명해|알려|써)\s*(?:주세요|줘)|"
    r"(?:just|only)\s+(?:the\s+)?(?:answer|result|expression\s+and\s+(?:the\s+)?answer)|"
    r"(?:answer|respond)\s+(?:briefly|concisely|only))",
    re.IGNORECASE,
)
_DIRECT_NO_FILE = re.compile(
    r"(?:(?:파일|아티팩트|문서)(?:은|는|을|를)?\s*(?:만들지|생성하지)\s*"
    r"(?:마세요|마|말아\s*(?:주세요|줘))|"
    r"(?:do\s+not|don't|never)\s+(?:create|make|generate)\s+(?:any\s+)?"
    r"(?:files?|artifacts?|documents?)|no\s+(?:files?|artifacts?|documents?))",
    re.IGNORECASE,
)


def _mask_quoted_intent(text: str) -> str:
    # Cache each opener's first closing quote in one reverse pass. Apostrophes
    # inside English words are not delimiters; Korean suffixes can follow quotes.
    ends: list[int | None] = [None] * len(text)
    next_closing: dict[str, int] = {}
    for index in range(len(text) - 1, -1, -1):
        character = text[index]
        if character == "\n":
            next_closing.clear()
            continue
        before = text[index - 1] if index else ""
        after = text[index + 1] if index + 1 < len(text) else ""
        latin_before = before.isascii() and before.isalpha()
        latin_after = after.isascii() and after.isalpha()
        closing = _QUOTE_PAIRS.get(character)
        if closing is not None and not (character == "'" and latin_before):
            ends[index] = next_closing.get(closing)
        if character in _QUOTE_ENDS and not (
            character in {"'", "’"} and latin_before and latin_after
        ):
            next_closing[character] = index

    intent = list(text)
    index = 0
    while index < len(text):
        end = ends[index]
        if end is None:
            index += 1
            continue
        intent[index : end + 1] = " " * (end + 1 - index)
        index = end + 1
    return "".join(intent)


def _has_numeric_arithmetic_action(text: str) -> bool:
    # "Add section 2" and "문단 2와 3을 더해" edit objects, not their numeric labels.
    text = " ".join(text.split())
    for match in _ARITHMETIC_ACTION.finditer(text):
        tail = text[match.end():]
        if (
            _EDITING_PREFIX.search(text[max(0, match.start() - 40):match.start()])
            or _EDITING_SUFFIX.search(tail[:40])
        ):
            continue
        if _NEGATED_ARITHMETIC.match(tail):
            # The same operands may still have an explicit replacement operation.
            replacement = _REPLACEMENT_ARITHMETIC.match(tail)
            if replacement is None or _NEGATED_ARITHMETIC.match(tail[replacement.end():]):
                continue
        return True
    return False


def _standalone_expression(request: str) -> bool:
    expression = _EXPRESSION_PREFIX.sub("", request.strip())
    expression = _EXPRESSION_SUFFIX.sub("", expression).strip()
    if (
        not expression
        or len(expression) > _MAX_EXPRESSION_CHARS
        or not _EXPRESSION_CHARS.fullmatch(expression)
        or _DATE.fullmatch(expression)
    ):
        return False
    try:
        nodes = list(ast.walk(ast.parse(expression, mode="eval")))
    except (SyntaxError, ValueError, RecursionError):
        return False
    return bool(
        len(nodes) <= 128
        and sum(isinstance(node, ast.Constant) for node in nodes) >= 2
        and any(isinstance(node, ast.BinOp) for node in nodes)
        and all(
            isinstance(
                node,
                (
                    ast.Expression,
                    ast.BinOp,
                    ast.UnaryOp,
                    ast.Constant,
                    ast.Add,
                    ast.Sub,
                    ast.Mult,
                    ast.Div,
                    ast.UAdd,
                    ast.USub,
                ),
            )
            for node in nodes
        )
    )


def direct_calculation_expression(request: str) -> str | None:
    """Copy one unambiguous user expression for an already-authorized calculator.

    The whole request must match: a literal expression, an optional question,
    and at most one answer-format and one no-file suffix. Unknown wording returns
    None so normal model-directed tool handling remains responsible. In particular,
    equations with a supplied result and word problems are never rewritten here.
    """
    if not isinstance(request, str) or len(request) > _MAX_REQUEST_CHARS:
        return None
    # NFKC can turn powers or indices into adjacent digits (2² -> 22).
    # Leave these notations to the model; only positional digits are copied.
    if any(
        unicodedata.category(character) == "No"
        or unicodedata.decomposition(character).startswith(("<super>", "<sub>"))
        for character in request
    ):
        return None
    text = unicodedata.normalize("NFKC", request).strip()
    text = text.replace("×", "*").replace("÷", "/").replace("−", "-")
    text = _EXPRESSION_PREFIX.sub("", text, count=1)
    literal = _DIRECT_LITERAL.match(text)
    if literal is None:
        return None
    expression = literal.group().strip()
    if ".." in expression:
        return None
    # A sentence's final period is not part of the copied numeric expression.
    expression = expression.removesuffix(".").rstrip()
    if _DATE.fullmatch(re.sub(r"\s", "", expression).strip("()")):
        return None
    if not _standalone_expression(expression):
        return None
    remainder = text[literal.end():]
    suffix = _DIRECT_CORE_SUFFIX.match(remainder)
    remainder = remainder[suffix.end():] if suffix else remainder
    clauses = [clause.strip() for clause in re.split(r"[.!?;\n]+", remainder) if clause.strip()]
    if len(clauses) > 2:
        return None
    seen: set[str] = set()
    for clause in clauses:
        category = (
            "format" if _DIRECT_FORMAT.fullmatch(clause)
            else "no_file" if _DIRECT_NO_FILE.fullmatch(clause)
            else None
        )
        if category is None or category in seen:
            return None
        seen.add(category)

    # Match the calculator's literal/depth bounds without computing a result.
    nesting = 0
    for character in expression:
        if character == "(":
            nesting += 1
            if nesting > 32:
                return None
        elif character == ")":
            nesting -= 1
    tree = ast.parse(expression, mode="eval")
    stack = [(tree.body, 0)]
    while stack:
        node, depth = stack.pop()
        if depth > 32:
            return None
        if isinstance(node, ast.Constant):
            segment = ast.get_source_segment(expression, node) or ""
            if sum(character.isdigit() for character in segment) > 64:
                return None
        stack.extend((child, depth + 1) for child in ast.iter_child_nodes(node))
    return expression


def requires_calculation(request: str) -> bool:
    """Recognize supplied-number arithmetic without inferring absent operands.

    A false result is absence of a strong request cue, not proof that no tool is
    useful. Callers must preserve ordinary model-directed tools on that path.
    """
    if not isinstance(request, str) or len(request) > _MAX_REQUEST_CHARS:
        return False
    text = unicodedata.normalize("NFKC", request)
    text = text.replace("×", "*").replace("÷", "/").replace("−", "-")
    text = _FENCE.sub(" ", text).strip()
    if _standalone_expression(text):
        return True

    # Quotes can supply numbers, but their embedded commands cannot establish intent.
    intent = _mask_quoted_intent(text)
    clauses: list[tuple[str, str, str]] = []
    start = 0
    previous_delimiter = ""
    for delimiter in _CLAUSE.finditer(intent):
        clauses.append(
            (text[start : delimiter.start()], intent[start : delimiter.start()], previous_delimiter)
        )
        start = delimiter.end()
        previous_delimiter = delimiter.group()
    clauses.append((text[start:], intent[start:], previous_delimiter))
    eligible: list[tuple[str, str]] = []
    transform_payload = False
    for data, words, before in clauses:
        if _NEW_TASK.fullmatch(before.strip()):
            transform_payload = False
        if _TRANSFORM.search(words):
            # An unquoted "Translate this:\nCalculate ..." remains source material.
            transform_payload = words.rstrip().endswith(":")
            continue
        if transform_payload:
            continue
        if _CODE.search(words) or _DECLINE.search(words):
            continue
        if _PROGRAM.search(words) and _BUILD.search(words):
            continue
        eligible.append((data, words))
    # A self-contained expression does not need a missing operand from another task.
    if any(_standalone_expression(raw) for raw, _ in eligible):
        return True
    data = " ".join(raw for raw, _ in eligible)
    if _MISSING.search(data):
        return False
    number_count = len(_NUMBER.findall(data))
    if number_count < 1:
        return False
    # Eligible clauses preserve commands but omit quoted instructions. Splitting
    # "and" between operands leaves whitespace, accepted by the addition grammar.
    arithmetic_action = _has_numeric_arithmetic_action(" ".join(words for _, words in eligible))
    for raw, words in eligible:
        if number_count >= 2 and (
            _CALCULATE.search(words)
            or arithmetic_action
            or (_TARGET.search(words) and _ASK.search(words + ("?" if "?" in text else "")))
        ):
            return True
        if _CONVERT.search(words):
            units = {match.group().casefold() for match in _UNIT.finditer(raw)}
            if len(units) >= 2 or _PERCENT_CONVERSION.search(raw):
                return True
    return False
