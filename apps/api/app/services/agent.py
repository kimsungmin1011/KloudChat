"""The tool-calling loop: model asks for a tool, the loop runs it and asks again, until prose or
`max_tool_hops`.

Tool results go back as `tool` role messages, never as instructions. A failing
tool returns its error as the result. Usage accumulates across hops.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from copy import deepcopy
from typing import Any, Literal, TypedDict

import httpx

from app.core.config import settings
from app.services import settings_store
from app.services.chat import ChatStreamError, step_label, step_title
from app.services.freshness import abstention_response
from app.services.tools import arithmetic
from app.services.tools.base import SearchEvidence, Tool, ToolContext, ToolResult, to_openai

log = logging.getLogger(__name__)


class ToolResultAnswerEvent(TypedDict):
    type: Literal["tool_result_answer"]
    answerOrigin: Literal["tool_result"]
    toolName: Literal["calculate"]
    reasonCode: Literal["division_by_zero"]
    actualModel: None


TOOL_RESULT_ANSWER_EVENT: ToolResultAnswerEvent = {
    "type": "tool_result_answer",
    "answerOrigin": "tool_result",
    "toolName": "calculate",
    "reasonCode": "division_by_zero",
    "actualModel": None,
}


def _literal_zero_division_answer(
    tool: Tool | None,
    result: ToolResult,
    *,
    literal_preset: bool,
    model_attempted: bool,
) -> ToolResultAnswerEvent | None:
    # Missing usage/model metadata does not prove that no provider was called.
    if (
        model_attempted or not literal_preset or tool is None
        or tool.name != "calculate" or tool.source != "builtin"
        or not tool.read_only or tool.run is not arithmetic.calculate or not result.failed
    ):
        return None
    try:
        error = json.loads(result.content)
    except (ValueError, TypeError):
        return None
    if isinstance(error, dict) and error.get("reason") == "division_by_zero":
        return dict(TOOL_RESULT_ANSWER_EVENT)
    return None


async def _client(api_key: str, *, redact_logging: bool = False) -> httpx.AsyncClient:
    """Client for the caller's virtual key; built per turn so the proxy URL follows the settings
    store.
    """
    base, _ = await settings_store.litellm_config()
    return httpx.AsyncClient(
        base_url=base.rstrip("/"),
        headers={
            "Authorization": f"Bearer {api_key}",
            **({"x-litellm-enable-message-redaction": "true"} if redact_logging else {}),
        },
        # `read` is the gap between chunks: a stream that stops sending is given up
        # long before the whole-turn budget runs out.
        timeout=httpx.Timeout(
            settings.chat_timeout_sec, connect=10.0, read=settings.chat_stall_sec
        ),
    )


class _Accumulator:
    """Reassembles one streamed choice; tool-call fragments arrive keyed by index."""

    def __init__(self) -> None:
        self.content: list[str] = []
        self.calls: dict[int, dict[str, Any]] = {}
        self.usage = {"inputTokens": 0, "outputTokens": 0}
        self.finish_reason: str | None = None
        self.actual_model: str | None = None
        #: Stream cut off by `_is_looping`.
        self.looped = False
        #: Stream cut off by `_runaway`: the run of one repeated character
        #: that was already emitted and has to be taken back.
        self.runaway: str | None = None

    def add_chunk(self, chunk: dict[str, Any]) -> str | None:
        """Returns newly emitted visible text, if any."""
        actual_model = chunk.get("model")
        if isinstance(actual_model, str) and actual_model:
            self.actual_model = actual_model
        if chunk.get("usage"):
            u = chunk["usage"]
            self.usage["inputTokens"] += int(u.get("prompt_tokens") or 0)
            self.usage["outputTokens"] += int(u.get("completion_tokens") or 0)

        text: str | None = None
        for choice in chunk.get("choices") or []:
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}

            for raw in delta.get("tool_calls") or []:
                index = raw.get("index", 0)
                call = self.calls.setdefault(index, {"id": None, "name": "", "arguments": ""})
                if raw.get("id"):
                    call["id"] = raw["id"]
                fn = raw.get("function") or {}
                if fn.get("name"):
                    call["name"] = fn["name"]
                if fn.get("arguments"):
                    call["arguments"] += fn["arguments"]

            piece = delta.get("content")
            if piece:
                self.content.append(piece)
                text = piece
        return text

    def assistant_message(self) -> dict[str, Any]:
        """The turn so far, in the shape the next request expects it back."""
        message: dict[str, Any] = {"role": "assistant", "content": "".join(self.content) or None}
        if self.calls:
            message["tool_calls"] = [
                {
                    "id": c["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                }
                for i, c in sorted(self.calls.items())
            ]
        return message


async def _stream_once(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[Tool],
    user_id: str,
    api_key: str,
    *,
    tool_definitions: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    strict_local: bool = False,
    disable_fallbacks: bool = False,
    redact_logging: bool = False,
    force_tool: str | None = None,
) -> AsyncIterator[tuple[str, Any]]:
    """Yields `('delta', text)` while streaming, then `('done', _Accumulator)`."""
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "user": user_id,
    }
    # Omitted, not defaulted: the model's own sampling applies.
    if temperature is not None:
        payload["temperature"] = temperature
    if tools:
        payload["tools"] = tool_definitions if tool_definitions is not None else to_openai(tools)
        payload["tool_choice"] = (
            {"type": "function", "function": {"name": force_tool}}
            if force_tool and any(t.name == force_tool for t in tools)
            else "auto"
        )
    if strict_local or disable_fallbacks:
        # Defence in depth beside the strict alias, which has no fallback.
        payload["disable_fallbacks"] = True

    acc = _Accumulator()
    try:
        async with await _client(api_key, redact_logging=redact_logging) as client:
            for attempt in range(len(_RETRY_AFTER) + 1):
                opened = client.stream("POST", "/v1/chat/completions", json=payload)
                response = await opened.__aenter__()
                if response.status_code == 429 and attempt < len(_RETRY_AFTER):
                    # Per-key token limits refresh by the minute.
                    await opened.__aexit__(None, None, None)
                    await asyncio.sleep(_RETRY_AFTER[attempt])
                    continue
                break
            try:
                if response.status_code >= 400:
                    body = (await response.aread()).decode(errors="replace")[:400]
                    detail = "response redacted" if redact_logging else body
                    raise ChatStreamError(f"upstream_{response.status_code}: {detail}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(raw)
                    except json.JSONDecodeError:
                        log.warning("undecodable chunk from litellm: %r", raw[:200])
                        continue
                    text = acc.add_chunk(chunk)
                    if text:
                        yield "delta", text
                        if _is_looping(acc.content):
                            # The stream is closed here; `run_turn` adds a note.
                            acc.looped = True
                            break
                        run = _runaway(acc.content)
                        if run:
                            acc.runaway = run
                            break
                    elif acc.calls and _arguments_runaway(acc.calls):
                        # A tool call whose arguments never end: same treatment.
                        acc.looped = True
                        break
            finally:
                await opened.__aexit__(None, None, None)
    except httpx.HTTPError as exc:
        raise ChatStreamError(f"upstream_unreachable: {exc}") from exc

    yield "done", acc


#: Text shorter than this, written in a hop that then called tools, is
#: narration (「검색해 보겠습니다」), not an answer.
_NARRATION_CHARS = 400

#: `web_search` calls per turn; other tools keep the normal hop budget.
MAX_WEB_SEARCHES = 3
#: `fetch_url` calls per turn: a model chasing a bus route through page after
#: page ran twenty minutes before this cap.
MAX_FETCHES = 6


def _repeats(earlier: str, later: str) -> bool:
    """Whether `later` says what `earlier` said — same opening, or most of its lines."""
    head = re.sub(r"\s+", " ", earlier.strip())[:80]
    if head and head in re.sub(r"\s+", " ", later):
        return True
    lines = [ln.strip() for ln in earlier.splitlines() if len(ln.strip()) > 20]
    if len(lines) < 3:
        return False
    return sum(1 for ln in lines if ln in later) * 2 > len(lines)


#: Seconds to wait before retrying a 429, one per retry.
_RETRY_AFTER = (5.0, 15.0)


#: Tool-call arguments longer than this are a decoder that never closes the
#: JSON; a document body handed to `create_artifact` stays well under it.
_ARGS_LIMIT = 60_000


def _arguments_runaway(calls: dict[int, dict[str, Any]]) -> bool:
    """A streamed tool call whose arguments repeat, run on one character, or
    outgrow any real payload — invisible to the text checks, so checked here."""
    for call in calls.values():
        arguments = call.get("arguments") or ""
        if len(arguments) > _ARGS_LIMIT:
            return True
        if len(arguments) >= 640 and (_is_looping([arguments]) or _runaway([arguments])):
            return True
    return False


def _is_looping(pieces: list[str], *, window: int = 160, times: int = 4) -> bool:
    """True when the last `window` characters already appear `times` times in the recent text."""
    text = "".join(pieces[-400:])
    if len(text) < window * times:
        return False
    needle = text[-window:].strip()
    return len(needle) >= window // 2 and text.count(needle) >= times


#: One letter or digit repeated this often in a row is a stuck decoder — a
#: URL whose id trails off into 「000000…」 — never text a person meant.
_RUN_LIMIT = 40
_RUN_RE = re.compile(rf"([^\W_])\1{{{_RUN_LIMIT - 1},}}$")


def _runaway(pieces: list[str]) -> str | None:
    """The run of one repeated character the recent text ends in, once it is too long."""
    match = _RUN_RE.search("".join(pieces[-200:]))
    return match.group(0) if match else None


def _repair_runaway(answer: str, run: str, seen_urls: set[str]) -> tuple[str, str, str]:
    """Takes the `run` off the end of `answer`: returns the prefix to keep, the
    text to add after it, and what happened — `completed` (the run broke a
    URL exactly one tool result knows, which is finished, closing bracket
    included), `dropped` (a URL nothing knows is removed whole, a link's text
    kept) or `cut` (the run was not in a URL)."""
    if not answer.endswith(run):
        return answer, "", "cut"
    answer = answer[: -len(run)]
    match = re.search(r"https?://\S*$", answer)
    if not match:
        return answer, "", "cut"
    prefix, char = match.group(0), run[0]
    linked = answer[max(match.start() - 2, 0) : match.start()] == "]("
    # Some of the repeated character may be the model's own: try the prefix
    # as written, then with its trailing copies of that character trimmed.
    cut = len(prefix)
    while cut > 0:
        head = prefix[:cut]
        known = [u for u in seen_urls if u.startswith(head) and u != head]
        if len(known) == 1:
            tail = known[0][cut:] + (")" if linked else "")
            return answer[: match.start() + cut], tail, "completed"
        if known or prefix[cut - 1] != char:
            break
        cut -= 1
    if linked:
        # 「[제목](https://…」 → 「제목」
        opened = answer.rfind("[", 0, match.start() - 2)
        if opened >= 0:
            return answer[:opened], answer[opened + 1 : match.start() - 2], "dropped"
    return answer[: match.start()], "", "dropped"


_URL = re.compile(r"https?://[^\s)\]>\"'」』,]+")


def _urls_in(text: str) -> list[str]:
    """Every http(s) URL in `text`, trailing punctuation dropped."""
    return [u.rstrip(".,;:") for u in _URL.findall(text or "")]


#: A numbered entry in a tool result: 「[3] 제목」 with the URL on the next line.
_NUMBERED = re.compile(r"^\[(\d+)\] (.*)$")


def _number_sources(
    content: str, sources: list[str], call: dict[str, Any], titles: dict[str, str] | None = None
) -> str:
    """Renumbers the `[n]` entries of a tool result so the numbers run across
    the whole turn, registering each URL in `sources`; a page fetched by URL
    gets a number of its own at the top. The model cites these numbers."""
    lines = content.split("\n")
    for i, line in enumerate(lines[:-1]):
        match = _NUMBERED.match(line)
        if not match:
            continue
        url = lines[i + 1].strip().rstrip(".,;:")
        if _URL.fullmatch(url):
            lines[i] = f"[{_source_number(url, sources)}] {match.group(2)}"
            if titles is not None:
                titles.setdefault(url, match.group(2).strip())
    content = "\n".join(lines)
    if call["name"] == "fetch_url" and not content.startswith("오류:"):
        try:
            url = str(json.loads(call["arguments"] or "{}").get("url") or "").strip()
        except (json.JSONDecodeError, AttributeError):
            url = ""
        if _URL.fullmatch(url):
            content = f"[{_source_number(url, sources)}] {url}\n\n{content}"
    return content


def _source_number(url: str, sources: list[str]) -> int:
    if url not in sources:
        sources.append(url)
    return sources.index(url) + 1


def _cite_titles(answer: str, sources: list[str], titles: dict[str, str]) -> str:
    """When the model cited nothing, a source whose title it copied — as a
    heading, a bold line, a list item — gets its `[n]` after that title. A
    code device for models that ignore the citation rule."""
    if _CITATION.search(answer):
        return answer
    for n, url in enumerate(sources, 1):
        title = re.split(r"\s+[-|·–—]\s+", titles.get(url, ""), maxsplit=1)[0].strip()
        if len(title) < 10:
            continue
        loose = r"\s*".join(re.escape(ch) for ch in title if not ch.isspace())
        match = re.search(loose, answer, re.IGNORECASE)
        if not match:
            continue
        at = match.end()
        if answer.startswith("**", at):
            at += 2
        answer = f"{answer[:at]} [{n}]{answer[at:]}"
    return answer


#: 「[1]」「[2, 5]」「[3-4]」 not already part of a markdown link.
_CITATION = re.compile(r"(?<!\[)\[(\d{1,2}(?:\s*[,，\-–]\s*\d{1,2})*)\](?!\()")


def _link_citations(answer: str, sources: list[str]) -> tuple[str, list[int]]:
    """Turns the model's `[n]` citations into links to the numbered sources
    (code blocks untouched); returns the answer and the numbers it cited."""
    cited: list[int] = []

    def numbers(spec: str) -> list[int]:
        found: list[int] = []
        for part in re.split(r"\s*[,，]\s*", spec):
            if re.fullmatch(r"\d+\s*[\-–]\s*\d+", part):
                lo, hi = (int(x) for x in re.split(r"\s*[\-–]\s*", part))
                found.extend(range(lo, hi + 1) if lo <= hi <= lo + 9 else [])
            else:
                found.append(int(part))
        return found

    def link(match: re.Match[str]) -> str:
        wanted = numbers(match.group(1))
        if not wanted or any(not 1 <= n <= len(sources) for n in wanted):
            return match.group(0)
        for n in wanted:
            if n not in cited:
                cited.append(n)
        return "".join(f"[[{n}]]({sources[n - 1]})" for n in wanted)

    pieces = answer.split("```")
    for i in range(0, len(pieces), 2):
        pieces[i] = _CITATION.sub(link, pieces[i])
    return "```".join(pieces), sorted(cited)


#: A path that is a front page under another name.
_INDEX_LEAVES = {
    "index",
    "index.html",
    "index.htm",
    "index.do",
    "index.php",
    "index.jsp",
    "main.do",
}


def _looks_like_a_source(url: str) -> bool:
    """A URL with a path, as opposed to a home page."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if not parsed.netloc or parsed.path in ("", "/"):
        return False
    leaf = parsed.path.rstrip("/").rsplit("/", 1)[-1].lower()
    return leaf not in _INDEX_LEAVES or bool(parsed.query)


def _is_homepage(url: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    return bool(parsed.netloc) and parsed.path in ("", "/")


def _source_label(url: str) -> str:
    """`host · last path segment` for a source list entry."""
    from urllib.parse import unquote, urlparse

    parsed = urlparse(url)
    host = parsed.netloc.removeprefix("www.")
    leaf = unquote(parsed.path.rstrip("/").rsplit("/", 1)[-1]).replace("-", " ")
    leaf = re.sub(r"\s+", " ", leaf).strip()
    return f"{host} · {leaf[:48]}" if leaf and leaf.lower() not in {"index.html", "index"} else host


def _source_priority(url: str) -> tuple[int, str]:
    """Sort key: government, then academic, then other, then wire services."""
    from urllib.parse import urlparse

    host = urlparse(url).netloc.lower().split(":", 1)[0].removeprefix("www.")
    if host.endswith((".go.kr", ".gov", ".gov.uk", ".gc.ca", ".europa.eu")):
        rank = 0
    elif host.endswith((".ac.kr", ".edu", ".edu.au")):
        rank = 1
    elif any(part in host for part in ("reuters.", "apnews.", "yna.co.kr")):
        rank = 3
    else:
        rank = 2
    return rank, url


def _without_duplicate_paragraphs(text: str, *, minimum: int = 80) -> tuple[str, list[str]]:
    """`(text, removed)`: exact repeats of paragraphs at least `minimum` characters long are
    dropped.
    """
    pieces = re.split(r"(\n\s*\n)", text)
    seen: set[str] = set()
    removed: list[str] = []
    for index in range(0, len(pieces), 2):
        paragraph = pieces[index]
        key = re.sub(r"\s+", " ", paragraph).strip()
        if len(key) < minimum or key not in seen:
            if len(key) >= minimum:
                seen.add(key)
            continue
        removed.append(paragraph)
        pieces[index] = ""
        if index and pieces[index - 1]:
            pieces[index - 1] = ""
    return "".join(pieces), removed


async def _run_tool(tool: Tool, arguments: str, ctx: ToolContext) -> ToolResult:
    try:
        parsed = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return ToolResult(
            content=f"오류: 인자를 JSON으로 해석할 수 없습니다: {arguments[:200]}", failed=True
        )
    if not isinstance(parsed, dict):
        return ToolResult(content="오류: 인자는 객체여야 합니다.", failed=True)

    try:
        async with asyncio.timeout(settings.tool_timeout_sec):
            output = await (tool.run(parsed, ctx) if tool.wants_context else tool.run(parsed))
    except TimeoutError:
        return ToolResult(
            content=f"오류: {tool.name} 도구가 시간 안에 응답하지 않았습니다.", failed=True
        )
    except Exception as exc:  # noqa: BLE001 — a broken tool must not end the turn
        # The exception text may embed an unsanitised response body: log the
        # type only.
        error_type = type(exc).__name__
        log.warning("tool %s failed (%s)", tool.name, error_type)
        return ToolResult(
            content=f"오류: {tool.name} 실행에 실패했습니다 ({error_type}).",
            failed=True,
        )

    if isinstance(output, ToolResult):
        return output
    return ToolResult(content=str(output))


async def run_turn(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[Tool],
    ctx: ToolContext,
    sanitize_tool_output: Callable[[str], tuple[str, int]] | None = None,
    sanitize_step_detail: Callable[[str], tuple[str, int]] | None = None,
    classify_tool_output: Callable[[str], list[dict[str, Any]]] | None = None,
    strict_local: bool = False,
    disable_fallbacks: bool = False,
    redact_logging: bool = False,
    tool_definitions: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    #: A tool the first ordinary hop must call, after any successful preflight.
    #: A named `tool_choice` is only a request — vLLM answers in prose about
    #: half the time under a long system prompt — so a search the toggle
    #: demands goes through `preset_call` instead.
    force_tool: str | None = None,
    #: Required gate; only eligible arithmetic reads may precede it. Hop prose stays private.
    preflight_tool: str | None = None,
    #: A non-arithmetic NCS decision must not unlock a required numeric answer.
    calculation_required: bool = False,
    #: A complete literal expression validated from the user's request, not inferred.
    calculation_expression: str | None = None,
    #: `(tool name, arguments)` the server calls itself before the model is
    #: asked anything; the model then starts with the result in hand. A required
    #: calculation may need this trusted read first. Other gates remain first.
    preset_call: tuple[str, dict[str, Any]] | None = None,
    #: Bounded current-political-fact request: the trusted first lookup must
    #: succeed before any model call. Retrieval presence is not fact validation.
    freshness_request: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Drives one assistant turn to a final answer.

    Emits `step`, `delta`, `retract`, `model_route`, `privacy_route`,
    optional `tool_result_answer` or `freshness_abstention` (no answer-model call),
    and exactly one `usage`.
    `done` belongs to the caller, after credits settle.
    """
    by_name = {t.name: t for t in tools}
    if freshness_request and (
        strict_local
        # General arithmetic may follow verified retrieval; NCS remains exclusive.
        or (
            preflight_tool
            and not (
                calculation_required
                and preflight_tool == "calculate"
                and "calculate" in by_name
                and by_name["calculate"].source == "builtin"
                and by_name["calculate"].read_only
            )
        )
        or not preset_call
        or preset_call[0] != "web_search"
        or "web_search" not in by_name
        or by_name["web_search"].source != "builtin"
        or not by_name["web_search"].read_only
        or (ctx.allowed and "web_search" not in ctx.allowed)
        or settings.max_tool_hops < 1
    ):
        yield {"type": "freshness_abstention", "reason": "verification_unavailable"}
        yield {"type": "delta", "text": abstention_response(freshness_request)}
        yield {"type": "usage", "inputTokens": 0, "outputTokens": 0}
        return
    if calculation_required and preflight_tool not in {"calculate", "check_ncs_answer"}:
        raise ChatStreamError("preflight_tool_unavailable")
    if calculation_expression is not None and (
        not calculation_required
        or preflight_tool != "calculate"
        or "calculate" not in by_name
        or by_name["calculate"].source != "builtin"
        or not by_name["calculate"].read_only
    ):
        raise ChatStreamError("preflight_tool_unavailable")
    if calculation_required and preset_call:
        prerequisite = by_name.get(preset_call[0])
        if (
            prerequisite is None
            or prerequisite.name not in {"web_search", "weather"}
            or prerequisite.source != "builtin"
            or not prerequisite.read_only
        ):
            raise ChatStreamError("preflight_tool_unavailable")
    if preflight_tool and (
        preflight_tool not in by_name
        or (ctx.allowed and preflight_tool not in ctx.allowed)
        or settings.max_tool_hops < 1
    ):
        raise ChatStreamError("preflight_tool_unavailable")
    conversation = list(messages)
    usage = {"inputTokens": 0, "outputTokens": 0}
    hop = 0
    preflight_completed = False
    preflight_repaired = False
    calculation_started = False
    read_prerequisites: set[str] = set()
    if (
        calculation_required and preflight_tool == "calculate"
        and calculation_expression is None and preset_call is None
    ):
        # Reuse the caller's configured read contract, never infer effects from a name.
        # The existing metadata is not a proof of a connector's actual behavior.
        read_prerequisites = {
            tool.name for tool in tools
            if tool.read_only is True
            and tool.name not in {
                "calculate", "check_ncs_answer", "execute_code",
                "create_artifact", "create_chart", "share_note",
            }
            and (not ctx.allowed or tool.name in ctx.allowed)
        }
    post_preflight_force_sent = False
    preset_calls = []
    if preset_call and (not preflight_tool or calculation_required):
        preset_calls.append(preset_call)
    if calculation_expression is not None:
        preset_calls.append(("calculate", {"expression": calculation_expression}))
    redact_next_request = redact_logging
    reported_models: set[str] = set()
    model_attempted = False

    def visible_label(tool: Tool | None, name: str, *, done: bool = False) -> str:
        # Progress form while running (웹 검색 중), noun when done (웹 검색).
        if done:
            label = (tool.title or tool.label) if tool else step_title(name)
        else:
            label = tool.label if tool else step_label(name)
        if sanitize_step_detail is not None:
            label, _ = sanitize_step_detail(label)
        return label

    #: The next call is the last: no tools, answer from what it has.
    closing = False
    #: Every URL a tool returned this turn.
    seen_urls: set[str] = set()
    #: (tool name, raw arguments) already dispatched — a model that cannot
    #: tell it already has the answer repeats the same call hop after hop
    #: otherwise, burning a full round trip each time until the hop cap.
    called: set[tuple[str, str]] = set()
    # Only the pending arithmetic gate can reuse evidence. Futures coalesce
    # concurrent duplicates; stored results are detached before output masking.
    arithmetic_evidence: dict[tuple[str, str], asyncio.Future[ToolResult | None]] = {}
    #: URLs the tools returned, in the order the model saw them numbered.
    sources: list[str] = []
    source_titles: dict[str, str] = {}
    answer_text: list[str] = []
    searches = 0
    empty_searches = 0
    fetches = 0
    #: Long text written in a hop that then called tools; retracted at the end
    #: if the final answer repeats it.
    held: list[str] = []
    while True:
        acc: _Accumulator | None = None
        hop_text: list[str] = []
        stream_kwargs: dict[str, Any] = {
            "strict_local": strict_local,
            "redact_logging": redact_next_request,
        }
        hop_tools = [] if closing else tools
        hop_definitions = [] if closing else tool_definitions
        pending_reads = read_prerequisites if not calculation_started else set()
        if preflight_tool and not preflight_completed and not closing:
            # Reads may supply missing operands; neither a read nor its prose
            # satisfies verification. Other tools remain unavailable until it succeeds.
            gate_names = {preflight_tool, *pending_reads}
            hop_tools = [tool for tool in tools if tool.name in gate_names]
            if hop_definitions is not None:
                hop_definitions = [
                    definition for definition in hop_definitions
                    if definition.get("function", {}).get("name") in gate_names
                ]
        if disable_fallbacks:
            stream_kwargs["disable_fallbacks"] = True
        # Without `tool_definitions`, `_stream_once` converts `tools` itself.
        if hop_definitions is not None:
            stream_kwargs["tool_definitions"] = hop_definitions
        if temperature is not None:
            stream_kwargs["temperature"] = temperature
        if preflight_tool and not preflight_completed and not closing and not pending_reads:
            stream_kwargs["force_tool"] = preflight_tool
        elif force_tool and not preflight_tool and hop == 0:
            stream_kwargs["force_tool"] = force_tool
        elif (
            preflight_tool
            and preflight_completed
            and force_tool
            and force_tool != preflight_tool
            and not post_preflight_force_sent
            and not closing
        ):
            # Keep an explicit search toggle after, never ahead of, a successful gate.
            stream_kwargs["force_tool"] = force_tool
            post_preflight_force_sent = True
        running_preset = hop < len(preset_calls) and not closing
        if running_preset:
            # Trusted lookup and literal arithmetic need no model argument guess.
            name, arguments = preset_calls[hop]
            acc = _Accumulator()
            acc.calls[0] = {"id": f"preset_{hop}", "name": name, "arguments": json.dumps(arguments)}
            if name == force_tool:
                post_preflight_force_sent = True
        else:
            model_attempted = True
            async for kind, value in _stream_once(
                model,
                conversation,
                hop_tools,
                ctx.user_id,
                ctx.api_key,
                **stream_kwargs,
            ):
                if kind == "delta":
                    hop_text.append(value)
                    if not preflight_tool:
                        answer_text.append(value)
                        yield {"type": "delta", "text": value}
                else:
                    acc = value
        assert acc is not None

        usage["inputTokens"] += acc.usage["inputTokens"]
        usage["outputTokens"] += acc.usage["outputTokens"]
        if acc.actual_model and acc.actual_model not in reported_models:
            reported_models.add(acc.actual_model)
            yield {
                "type": "model_route",
                "routedModel": model,
                "actualModel": acc.actual_model,
            }

        prerequisite_batch = False
        if preflight_tool:
            # Operands cannot come from an unread result in the same parallel batch.
            # Complete-hop validation also keeps drafts and disallowed calls private.
            gate_calls = list(acc.calls.values())
            valid_gate_calls = bool(gate_calls) and all(
                call["name"] == preflight_tool for call in gate_calls
            )
            if not (calculation_required and preflight_tool == "calculate"):
                valid_gate_calls = valid_gate_calls and len(gate_calls) == 1
            if not preflight_completed and valid_gate_calls:
                calculation_started = True
            prerequisite_batch = bool(
                not preflight_completed and not closing and gate_calls
                and all(call["name"] in pending_reads for call in gate_calls)
            )
            valid_gate_calls = valid_gate_calls or prerequisite_batch
            missed_preflight = (
                not preflight_completed and not running_preset and not valid_gate_calls
            )
            if (
                missed_preflight and calculation_required and not preflight_repaired
                and not acc.calls and not acc.looped and not acc.runaway and not closing
            ):
                # Some providers ignore named tool_choice. Retry once with only
                # a protocol reminder, never the unverified numeric draft.
                preflight_repaired = True
                conversation.append({
                    "role": "user",
                    "content": (
                        "아직 검산을 완료하지 못했습니다. 필요한 값이 자료에 있으면 "
                        "허용된 읽기 도구를 먼저 호출하고, 그 결과를 받은 다음 calculate로 "
                        "계산하세요. 읽기와 계산을 동시에 호출하거나 없는 값을 만들지 마세요. "
                        "검산 전 정답을 문장으로 반환하지 마세요."
                        if pending_reads else
                        f"아직 {preflight_tool} 도구 호출을 받지 못했습니다. "
                        "정답을 문장이나 JSON 본문으로 쓰지 말고, 제공된 함수 스키마에 맞춰 "
                        f"{preflight_tool} 도구 호출만 반환하세요. "
                        "원래 질문의 값과 단위를 보존하여 검산할 식을 전달하세요."
                    ),
                })
                continue
            if missed_preflight or acc.looped or acc.runaway or (closing and acc.calls):
                note = (
                    "문항 검산 절차를 완료하지 못해 정답이나 채점을 확정할 수 없습니다. "
                    "다시 시도해 주세요."
                )
                yield {
                    "type": "step",
                    "id": "preflight",
                    "label": visible_label(by_name[preflight_tool], preflight_tool, done=True),
                    "status": "error",
                }
                answer_text.append(note)
                yield {"type": "delta", "text": note}
                break
            if acc.calls:
                # A discarded calculation draft must not reinforce the next model hop.
                acc.content.clear()
            else:
                answer_text.extend(hop_text)
                for text in hop_text:
                    yield {"type": "delta", "text": text}

        if not preflight_tool and acc.calls and not closing and "".join(hop_text).strip():
            # Text spoken while calling tools: short is narration and goes now;
            # long may be the answer and is held until the end.
            spoken = "".join(hop_text)
            if len(spoken) < _NARRATION_CHARS:
                del answer_text[len(answer_text) - len(hop_text) :]
                yield {"type": "retract", "text": spoken}
            else:
                held.append(spoken)
        if acc.looped:
            note = (
                "\n\n_같은 내용이 되풀이되어 여기서 멈췄습니다. "
                "다시 시도하거나 다른 모델을 골라 보세요._"
            )
            answer_text.append(note)
            yield {"type": "delta", "text": note}
            break
        if acc.runaway:
            # One character repeating without end: take the run back, and
            # when it ate a URL the tools saw, finish that URL properly.
            before = "".join(answer_text)
            kept, tail, outcome = _repair_runaway(before, acc.runaway, seen_urls)
            yield {"type": "retract", "text": before[len(kept) :]}
            if tail:
                yield {"type": "delta", "text": tail}
            note = {
                "completed": (
                    "\n\n_주소가 같은 글자를 되풀이해 여기서 멈추고, "
                    "검색 결과에 있던 주소로 바로잡았습니다._"
                ),
                "dropped": (
                    "\n\n_주소가 같은 글자를 되풀이해 여기서 멈췄고, 검색 결과에 없는 "
                    "그 주소는 걷어 냈습니다._"
                ),
                "cut": (
                    "\n\n_같은 글자가 되풀이되어 여기서 멈췄습니다. "
                    "다시 시도하거나 다른 모델을 골라 보세요._"
                ),
            }[outcome]
            yield {"type": "delta", "text": note}
            answer_text[:] = [kept + tail + note]
            break
        if closing:
            break
        if not acc.calls:
            if hop and not "".join(acc.content).strip():
                # Tools ran but the answer is empty: ask once more without tools.
                conversation.append(acc.assistant_message())
                conversation.append(
                    {
                        "role": "user",
                        "content": (
                            "답이 비어 있습니다. 지금까지 모은 자료로 답을 쓰세요. "
                            "자료가 부족하면 무엇이 더 필요한지 물으세요."
                        ),
                    }
                )
                closing = True
                continue
            break

        hop += 1
        if hop > settings.max_tool_hops:
            # Hop cap: one last call with no tools, answering from what it has.
            conversation.append(acc.assistant_message())
            for index, call in sorted(acc.calls.items()):
                conversation.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or f"call_{index}",
                        "content": "(도구 호출 한도에 닿아 실행하지 않았습니다.)",
                    }
                )
            conversation.append(
                {
                    "role": "user",
                    "content": (
                        "도구는 더 쓸 수 없습니다. 지금까지 모은 자료로 답을 쓰세요. "
                        "확인하지 못한 항목은 확인하지 못했다고 밝히세요."
                    ),
                }
            )
            closing = True
            continue

        conversation.append(acc.assistant_message())

        # Tool calls within a hop run concurrently.
        planned = [
            (index, call, by_name.get(call["name"])) for index, call in sorted(acc.calls.items())
        ]
        for index, call, tool in planned:
            yield {
                "type": "step",
                "id": f"h{hop}_{index}",
                "label": visible_label(tool, call["name"]),
                "status": "running",
            }

        async def execute(
            item: tuple[int, dict[str, Any], Tool | None],
            *,
            arithmetic_gate_pending: bool = calculation_required and not preflight_completed,
        ) -> ToolResult:
            _, call, tool = item
            if tool is None:
                return ToolResult(content=f"오류: 알 수 없는 도구 {call['name']}", failed=True)
            if ctx.allowed and tool.name not in ctx.allowed:
                return ToolResult(
                    content=f"오류: {tool.name} 도구가 허용되지 않았습니다.", failed=True
                )
            key = (tool.name, call["arguments"])
            reuse_arithmetic = bool(
                arithmetic_gate_pending
                and tool.name == preflight_tool
                and tool.name in {"calculate", "check_ncs_answer"}
                and tool.source == "builtin"
                and tool.read_only
            )
            if key in called:
                pending = arithmetic_evidence.get(key) if reuse_arithmetic else None
                if pending is not None:
                    saved = await asyncio.shield(pending)
                    if saved is not None:
                        return deepcopy(saved)
                return ToolResult(
                    content=(
                        "(같은 도구를 같은 조건으로 이미 호출했습니다. "
                        "위에서 받은 결과로 답하세요.)"
                    )
                )
            called.add(key)
            pending = None
            if reuse_arithmetic:
                pending = asyncio.get_running_loop().create_future()
                arithmetic_evidence[key] = pending
            ctx.tool_calls[tool.name] = ctx.tool_calls.get(tool.name, 0) + 1
            try:
                result = await _run_tool(tool, call["arguments"], ctx)
                if pending is not None and not result.failed and not result.empty:
                    try:
                        evidence = json.loads(result.content)
                    except (ValueError, TypeError):
                        evidence = None
                    verified = isinstance(evidence, dict) and "exact" in evidence
                    if tool.name == "check_ncs_answer":
                        verified = verified and evidence.get("arithmetic_verified") is True
                    if verified:
                        pending.set_result(deepcopy(result))
                return result
            finally:
                if pending is not None and not pending.done():
                    # Failure or cancellation must not strand a duplicate waiter.
                    pending.set_result(None)

        results = await asyncio.gather(*(execute(item) for item in planned))
        if (
            freshness_request
            and hop == 1
            and any(
                result.failed
                or result.empty
                or not isinstance(result.search_evidence, SearchEvidence)
                or not result.search_evidence.source_urls
                for result in results
            )
        ):
            for index, call, tool in planned:
                yield {
                    "type": "step",
                    "id": f"h{hop}_{index}",
                    "label": visible_label(tool, call["name"], done=True),
                    "status": "error",
                    "detail": "Current information could not be verified.",
                }
            yield {"type": "freshness_abstention", "reason": "lookup_failed_or_empty"}
            yield {"type": "delta", "text": abstention_response(freshness_request)}
            yield {"type": "usage", "inputTokens": 0, "outputTokens": 0}
            return
        terminal_text: str | None = None
        terminal_origin: ToolResultAnswerEvent | None = None
        verifying_arithmetic = calculation_required and not preflight_completed
        arithmetic_results: list[bool] = []

        for (index, call, tool), result in zip(planned, results, strict=True):
            if prerequisite_batch:
                if result.failed or result.empty or not result.content.strip():
                    result.failed = True
                    result.final_text = (
                        "계산에 앞서 필요한 자료를 확인하지 못해 답을 확정할 수 없습니다. "
                        "확인할 수 있는 수치와 조건을 제공해 주세요."
                    )
                else:
                    # A read can supply operands, but cannot terminate a numeric answer.
                    result.final_text = None
            result_origin = _literal_zero_division_answer(
                tool, result,
                literal_preset=running_preset and calculation_expression is not None,
                model_attempted=model_attempted,
            )
            if result_origin is not None:
                # Only a copied user literal, evaluated by our in-process calculator,
                # can establish this fact. Never echo arguments or tool error prose.
                result.final_text = (
                    "0으로 나누는 계산은 정의되지 않으므로 값을 구할 수 없습니다."
                )
            if (
                running_preset and calculation_required and calculation_expression is None
                and call["name"] != preflight_tool and (result.failed or result.empty)
            ):
                result.final_text = (
                    "계산에 앞서 필요한 자료를 확인하지 못해 답을 확정할 수 없습니다. "
                    "확인할 수 있는 수치와 조건을 제공해 주세요."
                )
            if (
                verifying_arithmetic
                and call["name"] == preflight_tool and not result.failed
            ):
                try:
                    evidence = json.loads(result.content)
                except (ValueError, TypeError):
                    evidence = None
                verified = isinstance(evidence, dict) and "exact" in evidence
                if call["name"] == "check_ncs_answer":
                    verified = verified and evidence.get("arithmetic_verified") is True
                if not verified:
                    result.failed = True
                    result.detail = "수치 검산 미완료"
                    result.final_text = (
                        result.final_text
                        or "수치 검산을 완료하지 못해 답을 확정할 수 없습니다. "
                        "계산에 필요한 조건과 단위를 확인해 주세요."
                    )
            if verifying_arithmetic and call["name"] == preflight_tool:
                arithmetic_results.append(not result.failed)
            elif preflight_tool and call["name"] == preflight_tool and not result.failed:
                preflight_completed = True
            finding_counts: dict[tuple[str, str], int] = {}

            def collect(
                raw: str,
                counts: dict[tuple[str, str], int] = finding_counts,
            ) -> None:
                if classify_tool_output is None:
                    return
                for finding in classify_tool_output(raw):
                    key = (
                        str(finding.get("category") or "unknown"),
                        str(finding.get("source") or "tool_output"),
                    )
                    counts[key] = counts.get(key, 0) + int(finding.get("count") or 0)

            collect(result.content)
            if result.detail:
                collect(result.detail)
            if result.final_text is not None:
                collect(result.final_text)
            if sanitize_tool_output is not None:
                result.content, protected = sanitize_tool_output(result.content)
                if result.detail:
                    result.detail, detail_protected = sanitize_tool_output(result.detail)
                    protected += detail_protected
                if result.final_text is not None:
                    result.final_text, terminal_protected = sanitize_tool_output(result.final_text)
                    protected += terminal_protected
                if protected:
                    # The next request carries privacy labels: redact its log.
                    redact_next_request = True
                    yield {
                        "type": "privacy_route",
                        "action": "mask_external",
                        "source": "tool_output",
                        "count": protected,
                        "findings": [
                            {"category": category, "source": source, "count": count}
                            for (category, source), count in sorted(finding_counts.items())
                        ],
                    }
            elif sanitize_step_detail is not None:
                # Strict-local: the model sees the raw result, but the
                # persisted timeline detail and direct terminal answer are sanitised.
                if result.detail:
                    result.detail, _ = sanitize_step_detail(result.detail)
                if result.final_text is not None:
                    result.final_text, _ = sanitize_step_detail(result.final_text)
            if finding_counts and sanitize_tool_output is None:
                # Strict-local hop with findings: LiteLLM's log must still redact it.
                redact_next_request = True
                yield {
                    "type": "privacy_route",
                    "action": "strict_local",
                    "source": "tool_output",
                    "count": sum(finding_counts.values()),
                    "findings": [
                        {"category": category, "source": source, "count": count}
                        for (category, source), count in sorted(finding_counts.items())
                    ],
                }
            yield {
                "type": "step",
                "id": f"h{hop}_{index}",
                "label": visible_label(tool, call["name"], done=True),
                "status": "error" if result.failed else "done",
                **({"detail": result.detail} if result.detail else {}),
            }
            result.content = _number_sources(result.content, sources, call, source_titles)
            conversation.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"] or f"call_{index}",
                    "name": call["name"],
                    "content": result.content,
                }
            )
            if not result.failed:
                # A failed call's own content is an error message, not a source —
                # httpx's default text for a bad status even links to MDN's docs
                # on that status code, which is not something anyone searched for.
                seen_urls.update(_urls_in(result.content))
            if call["name"] == "web_search":
                searches += 1
                empty_searches += int(result.empty)
            elif call["name"] == "fetch_url":
                fetches += 1
            if terminal_text is None and result.final_text is not None:
                terminal_text = result.final_text
                terminal_origin = result_origin

        if arithmetic_results:
            preflight_completed = all(arithmetic_results)
        if terminal_text is not None:
            answer_text.append(terminal_text)
            if terminal_origin is not None:
                yield terminal_origin
            yield {"type": "delta", "text": terminal_text}
            break

        if searches >= MAX_WEB_SEARCHES or fetches >= MAX_FETCHES:
            conversation.append(
                {
                    "role": "user",
                    "content": (
                        (
                            "웹 검색은 충분히 했습니다. "
                            if searches >= MAX_WEB_SEARCHES
                            else "문서는 충분히 읽었습니다. "
                        )
                        + "도구를 더 쓰지 말고 지금까지 "
                        "확인한 자료로 답하세요. 확인하지 못한 항목은 그렇게 밝히고, "
                        "실제 검색 결과에 있던 URL만 출처로 쓰세요."
                    ),
                }
            )
            closing = True

    # Post-processing: retract repeated held text and duplicate paragraphs,
    # then annotate the answer's URLs against `seen_urls`.
    answer = "".join(answer_text)
    for spoken in held:
        at = answer.find(spoken)
        final = answer[at + len(spoken) :] if at >= 0 else ""
        if _repeats(spoken, final):
            answer = answer.replace(spoken, "", 1)
            yield {"type": "retract", "text": spoken}
    answer, duplicate_paragraphs = _without_duplicate_paragraphs(answer)
    for paragraph in duplicate_paragraphs:
        yield {"type": "retract", "text": paragraph}
    linked, cited = _link_citations(_cite_titles(answer, sources, source_titles), sources)
    if linked != answer:
        # The citations sit mid-text, so the answer is re-sent whole.
        yield {"type": "retract", "text": answer}
        yield {"type": "delta", "text": linked}
        answer = linked
    answer_text[:] = [answer]
    if searches and empty_searches * 2 >= searches and answer.strip():
        note = (
            "\n\n_웹 검색이 쓸 만한 결과를 주지 않아 이 답은 검색으로 확인하지 못했습니다. "
            "서지·수치·최신 사항은 확인이 필요합니다._"
            if empty_searches == searches
            else "\n\n_웹 검색 결과가 대부분 질문과 무관해 이 답은 충분히 확인되지 않았습니다. "
            "서지·수치·최신 사항은 확인이 필요합니다._"
        )
        answer_text.append(note)
        yield {"type": "delta", "text": note}
    verified_in_answer = {u for u in _urls_in(answer) if u in seen_urls}
    # The search hits themselves; URLs found inside page bodies (links, ads,
    # language switches) only when the tools numbered nothing.
    source_urls = [u for u in sources if _looks_like_a_source(u)] or sorted(
        (u for u in seen_urls if _looks_like_a_source(u)),
        key=_source_priority,
    )
    if cited:
        appendix = "\n\n### 출처\n" + "\n".join(
            f"- [{n}] [{_source_label(sources[n - 1])}]({sources[n - 1]})" for n in cited
        )
        answer_text.append(appendix)
        yield {"type": "delta", "text": appendix}
    elif searches and source_urls and not verified_in_answer:
        # Only URLs a tool returned are appended.
        appendix = "\n\n### 확인한 출처\n" + "\n".join(
            f"- [{_source_label(url)}]({url})" for url in source_urls[:5]
        )
        answer_text.append(appendix)
        yield {"type": "delta", "text": appendix}
    unverified = [u for u in _urls_in(answer) if u not in seen_urls and _looks_like_a_source(u)]
    if unverified and seen_urls:
        note = (
            "\n\n_다음 링크는 이 답을 쓰며 검색·열람한 결과에 없던 것입니다. 기억으로 적은 "
            "것이니 열어 보고 확인하세요: " + ", ".join(dict.fromkeys(unverified)) + "_"
        )
        answer_text.append(note)
        yield {"type": "delta", "text": note}
    homepages = [u for u in _urls_in(answer) if _is_homepage(u)]
    if searches and homepages:
        note = (
            "\n\n_기관 홈페이지 첫 화면은 위 주장을 뒷받침하는 직접 출처가 아닙니다. "
            "해당 보고서·보도자료의 원문 주소를 확인하세요: "
            + ", ".join(dict.fromkeys(homepages))
            + "_"
        )
        answer_text.append(note)
        yield {"type": "delta", "text": note}

    yield {"type": "usage", **usage}
