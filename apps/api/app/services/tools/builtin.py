"""Built-in tools: SearXNG search, Crawl4AI fetch (Firecrawl-shaped shim), sandboxed code,
artifacts, charts and shared notes.

Backend addresses come from `settings_store.tools_config`; a tool with no address is not offered.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date
from html import unescape
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.core import logs
from app.core.config import settings
from app.services import index_client, knowledge, netguard, settings_store
from app.services.tools.arithmetic import CALCULATE
from app.services.tools.base import SearchEvidence, Tool, ToolContext, ToolResult
from app.services.tools.ncs_check import CHECK_NCS_ANSWER

log = logging.getLogger(__name__)

_FETCH_TIMEOUT = httpx.Timeout(45.0, connect=10.0)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n…(이하 {len(text) - limit:,}자 생략)"


# ── web search ─────────────────────────────────────────────────────────


def _terms(query: str) -> list[str]:
    """Query words a result is scored against."""
    words = re.findall(r"[\w가-힣-]+", query.lower())
    return [w for w in words if len(w) >= 2 and not w.isdigit()]


def _covers(text: str, term: str) -> bool:
    if term in text:
        return True
    # Drop a trailing Korean particle (청소년의 → 청소년) or counter (2026년 → 2026).
    return len(term) >= 3 and term[-1] in "의은는이가을를과와에로도년월일" and term[:-1] in text


def _rank(rows: list[dict[str, str]], query: str) -> list[dict[str, str]]:
    """Results carrying more query words first; engine order kept among equals.
    A hit from the query's own lane (a paper from the science engines, an
    article from the news engines) gets a head start of half the query's words:
    a blog that repeats the whole question outranks the paper itself otherwise,
    while a lane hit about something else still sinks."""
    terms = _terms(query)
    names, _ = _anchors(query)
    head_start = len(terms) // 2 + 1

    def score(row: dict[str, str]) -> int:
        overlap = _overlap(row, terms)
        # A lane hit is judged against the words its lane was asked with (the
        # English lane saw 「Ubuntu 24.04」, not the Korean sentence), and gets
        # the head start only when it fits half of them; the science lane also
        # returns papers that merely share a word. The English lane, being a
        # supplement, gets a single step.
        lane_query = row.get("lane_query")
        if lane_query:
            lane_terms = _terms(lane_query) or terms
            fits = _overlap(row, lane_terms) * 2 >= len(lane_terms)
            # The kind's lane and a lane the person asked for (official) lead;
            # the English lane, a supplement, gets a single step.
            boosted = head_start if row.get("lane") in ("kind", "official") else 1
        else:
            fits = boosted = False
        # A community thread answers, but a page that is not one ranks first;
        # the subject's own site ranks ahead of everything.
        community = any(_host(row["url"]).endswith(h) for h in _COMMUNITY_HOSTS)
        return (
            overlap
            + (boosted if fits else 0)
            + (2 if _own_site(row, names) else 0)
            - (1 if community else 0)
        )

    if len(terms) < 2 and not names:
        return rows
    return sorted(rows, key=score, reverse=True)


def _overlap(row: dict[str, str], terms: list[str]) -> int:
    text = f"{row['title']} {row['snippet']} {row['url']}".lower()
    return sum(1 for t in terms if _covers(text, t))


def _off_topic(rows: list[dict[str, str]], query: str) -> bool:
    """No result carries even one word of a multi-word query (engine suspended or captcha'd)."""
    terms = _terms(query)
    return len(terms) >= 2 and all(_overlap(row, terms) == 0 for row in rows)


#: A path that is a front page under another name; such a hit answers nothing.
_INDEX_LEAVES = {
    "index",
    "index.html",
    "index.htm",
    "index.do",
    "index.asp",
    "index.php",
    "main.do",
}
#: Hits per host kept, so one blog's series does not fill the list.
_PER_HOST = 2


def _front_page(url: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.query:
        return False
    path = parsed.path.rstrip("/")
    return not path or path.rsplit("/", 1)[-1].lower() in _INDEX_LEAVES


def _host(url: str) -> str:
    from urllib.parse import urlparse

    return urlparse(url).netloc.lower().removeprefix("www.").removeprefix("m.")


#: Korean boards and Q&A sites: kept, ranked a step below everything else.
_COMMUNITY_HOSTS = (
    "instiz.net",
    "dcinside.com",
    "fmkorea.com",
    "ppomppu.co.kr",
    "clien.net",
    "kin.naver.com",
    "a-ha.io",
    "cafe.daum.net",
    "cafe.naver.com",
)

#: Words that carry no subject on their own in a Latin-alphabet query.
_LATIN_STOPWORDS = frozenset(
    "the a an and or of to in on for with is are was be do does how what when where "
    "which who why can i my me you your it its this that these those need needed current "
    "latest new best top vs from by at as into about".split()
)
#: Pages that never answer a Korean user's question: social feeds and foreign
#: Q&A boards (TikTok, Blind, HiNative, Reddit, Quora) that a general engine
#: returns for a query it did not understand, and adult sites.
_UNWANTED_HOSTS = (
    "tiktok.com",
    "instagram.com",
    "pinterest.",
    "facebook.com",
    "x.com",
    "twitter.com",
    "threads.net",
    "teamblind.com",
    "hinative.com",
    "reddit.com",
    "quora.com",
)
_UNWANTED = re.compile(r"야동|섹스|성인\s*(?:사이트|영상)|19금|porn|xxx|hentai|에로|성인야", re.I)


#: Korean places that carry no 시·구·동 suffix in everyday speech.
_KR_TOWNS = frozenset(
    "분당 판교 강남 홍대 잠실 일산 광교 동탄 송도 해운대 서면 명동 이태원 여의도 마곡 상암 위례 "
    "목동 노원 수지 죽전 정자 서현 야탑 미금 평촌 산본 부평 성남 용인 수원 화성 오산 평택 천안 "
    "세종 대전 대구 부산 광주 울산 인천 서울 제주 강릉 속초 춘천 원주 청주 전주 여수 순천 포항 "
    "경주 창원 김해 진주 목포 군산 안산 시흥 김포 파주 남양주 구리 하남 고양 의정부 광명 안양 "
    "군포 의왕 과천 양주 포천 동두천 이천 여주 안성 양평 가평 연천".split()
)
_KR_PLACE = re.compile(r"[가-힣]{1,4}(?:특별시|광역시|시|구|군|읍|면|동|리)(?=\s|$)")


def _places(query: str) -> list[str]:
    """Korean place names in the query — 분당, 성남시, 정자동 — as their stem
    (성남시 → 성남). A hit about somewhere else is not an answer."""
    found: list[str] = []
    for token in re.findall(r"[가-힣]+", query):
        if token in _KR_TOWNS:
            found.append(token)
        elif _KR_PLACE.fullmatch(token) and len(token) >= 3:
            stem = re.sub(r"(?:특별시|광역시|시|구|군|읍|면|동|리)$", "", token)
            if len(stem) >= 2:
                found.append(stem)
    return found


def _anchors(query: str) -> tuple[list[str], list[str]]:
    """The query's proper nouns as far as text can tell, as `(names, versions)`:
    Latin-alphabet words of four letters or more (FastAPI, Ubuntu, NeurIPS —
    three-letter ones like LTS or CVE are too common to anchor on) and tokens
    with digits (24.04, D-2, 3.14). A hit must carry one of the names and every
    version: a page about Ubuntu that never says 24.04 is not about 24.04.
    Korean places (`_places`) are checked beside these, each mandatory."""
    names: list[str] = []
    versions: list[str] = []
    for token in re.findall(r"[A-Za-z][A-Za-z0-9.+#_-]*|\d+(?:\.\d+)+|[A-Za-z]-\d+", query):
        lowered = token.lower().strip(".-")
        if lowered in _LATIN_STOPWORDS:
            continue
        if any(ch.isdigit() for ch in lowered):
            versions.append(lowered)
        elif len(lowered) >= 4:
            names.append(lowered)
    # A bare major version after a name: Node.js 22, React 19, PostgreSQL 17.
    for match in re.finditer(r"[A-Za-z][A-Za-z.+#_-]*\s+(\d{1,3})(?![\d.])", query):
        versions.append(match.group(1))
    return names, versions


#: A title mostly in another script (Cyrillic, Thai, Arabic, Hebrew) answers a
#: Korean or English question only by accident.
_OTHER_SCRIPTS = re.compile(r"[\u0400-\u04FF\u0E00-\u0E7F\u0600-\u06FF\u0590-\u05FF]")


def _foreign_script(title: str) -> bool:
    letters = [ch for ch in title if ch.isalpha()]
    return bool(letters) and sum(1 for ch in letters if _OTHER_SCRIPTS.match(ch)) * 3 > len(letters)


def _anchored(
    row: dict[str, str], anchors: tuple[list[str], list[str]], places: list[str] = ()
) -> bool:
    names, versions = anchors
    text = f"{row['title']} {row['snippet']} {row['url']}".lower()
    if names and not any(name in text for name in names):
        return False
    if not all(version in text for version in versions):
        return False
    return all(place in text for place in places)


def _own_site(row: dict[str, str], names: list[str]) -> bool:
    """The subject's own domain — nodejs.org for Node.js, ubuntu.com for Ubuntu,
    neurips.cc for NeurIPS: the page a question about it should start from."""
    host = _host(row["url"]).replace("-", "")
    return any(re.sub(r"[^a-z0-9]", "", name) in host for name in names if len(name) >= 4)


def _unwanted(row: dict[str, str]) -> bool:
    host = _host(row["url"])
    if any(host == h or host.endswith("." + h) or h in host for h in _UNWANTED_HOSTS):
        return True
    return bool(_UNWANTED.search(f"{row['title']} {row['url']}")) or _foreign_script(row["title"])


def _select(rows: list[dict[str, str]], query: str, count: int) -> list[dict[str, str]]:
    """The best `count` of `rows` (given news-first for a fresh query): duplicates,
    feeds, adult pages and hits without the query's proper nouns out, front
    pages benched, at most `_PER_HOST` per host, then `_rank`."""
    seen: set[str] = set()
    per_host: dict[str, int] = {}
    kept: list[dict[str, str]] = []
    benched: list[dict[str, str]] = []
    anchors = _anchors(query)
    places = _places(query)
    for row in rows:
        url = row["url"].rstrip("/")
        if not url or url in seen:
            continue
        seen.add(url)
        if _unwanted(row) or not _anchored(row, anchors, places):
            continue
        host = _host(url)
        if _front_page(url) or per_host.get(host, 0) >= _PER_HOST:
            benched.append(row)
            continue
        per_host[host] = per_host.get(host, 0) + 1
        kept.append(row)
    # A thin list is padded with what was benched rather than left short.
    kept.extend(benched[: max(0, count - len(kept))])
    return _rank(kept, query)[:count]


def _latin_only(query: str) -> str:
    """The query's Latin-alphabet and numeric tokens, or the whole query when
    there are fewer than two of them."""
    tokens = [
        t
        for t in re.findall(r"[A-Za-z][A-Za-z0-9.+#_'-]*|\d[\d.]*", query)
        if t.lower() not in ("arxiv", "doi", "paper", "preprint")
    ]
    return " ".join(tokens) if len(tokens) >= 2 else query


#: Korean intent words an English-language page would state in English. Only
#: these travel into the English lane; the subject's name is already Latin.
_INTENT_EN = [
    # Specific intents first: only the first two travel, and 「날짜」 is in
    # almost every question.
    (re.compile(r"지원\s*종료|서비스\s*종료|종료일|EOL", re.I), "end of life"),
    (re.compile(r"마감일|마감|제출\s*기한"), "deadline"),
    (re.compile(r"최신\s*버전|최신\s*판"), "latest version"),
    (re.compile(r"릴리스|출시"), "release"),
    (re.compile(r"가격|요금|비용"), "price"),
    (re.compile(r"취약점|보안\s*권고"), "vulnerability"),
    (re.compile(r"오류|에러"), "error"),
    (re.compile(r"설치"), "install"),
    (re.compile(r"사양|스펙"), "specs"),
    (re.compile(r"비교|차이"), "vs"),
    (re.compile(r"공식"), "official"),
    (re.compile(r"등록|신청"), "registration"),
    (re.compile(r"비자|비자\s*면제"), "visa"),
    (re.compile(r"지원\s*정책|정책"), "support policy"),
    (re.compile(r"일정|날짜"), "dates"),
]

#: Time words that narrow a `site:go.kr` search to nothing: the notice says
#: 「2026년」 in its body, not its title.
_TIME_NOISE = re.compile(r"\b20\d\d년?\b|올해|작년|내년|최근|지금|현재|오늘|요즘")


def _core_query(query: str) -> str:
    return re.sub(r"\s+", " ", _TIME_NOISE.sub(" ", query)).strip() or query


def _english_query(query: str) -> str:
    """The query for the English lane: its Latin-alphabet tokens plus the
    English word for what it asks (「Ubuntu 24.04 지원 종료일」 → 「Ubuntu 24.04
    end of life」), or the whole query when nothing is Latin."""
    tokens = [
        t
        for t in re.findall(r"[A-Za-z][A-Za-z0-9.+#_'-]*|\d[\d.]*", query)
        if t.lower() not in ("arxiv", "doi", "paper", "preprint")
    ]
    if not tokens or all(t[0].isdigit() for t in tokens):
        return query
    extras = [word for pattern, word in _INTENT_EN if pattern.search(query)]
    if len(tokens) < 2 and not extras:
        return query
    return " ".join([*tokens, *extras[:2]])


#: A question about a paper, whatever the model called the search.
_PAPER_CUES = re.compile(r"논문|arxiv|\bdoi\b|preprint|학술지|저널|\bpaper\b", re.I)

#: SearXNG parameters of each search kind's own lane; "web" has none.
_LANES: dict[str, dict[str, str]] = {
    "news": {"categories": "news", "time_range": "month"},
    "papers": {"categories": "science"},
    "code": {"categories": "it"},
}


#: Search hints the caller may pass — parsed from the user's own words by
#: `context.search_hints`, or set by the model on the tool call.
_TIME_RANGES = ("day", "week", "month", "year")
_LANGUAGES = {"ko": "ko-KR", "ko-KR": "ko-KR", "en": "en"}


async def _searxng(
    base_url: str,
    query: str,
    count: int,
    *,
    fresh: bool = False,
    kind: str = "web",
    hints: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """Search hits for `query`. Beside the general lane run, as they apply:
    the kind's own lane (news for a fresh query, science for papers, IT for
    code); an English lane when the subject has a Latin-alphabet name (Ubuntu
    24.04, NeurIPS 2026 — the official page is English and a Korean locale
    hides it); a `site:go.kr` lane for `official`; and `site`, `time_range`
    and `language` hints on every lane. Lane hits that fit the question come
    first."""
    hints = hints or {}
    search_url = f"{base_url.rstrip('/')}/search"
    site = str(hints.get("site") or "").strip().lstrip("site:")
    q = f"{query} site:{site}" if site else query
    base: dict[str, Any] = {"q": q, "format": "json", "safesearch": 2, "language": "ko-KR"}
    if hints.get("language") in _LANGUAGES:
        base["language"] = _LANGUAGES[str(hints["language"])]
    if hints.get("time_range") in _TIME_RANGES:
        base["time_range"] = hints["time_range"]
    lane_requests: list[tuple[str, dict[str, Any]]] = []
    lane = _LANES.get("news" if fresh and kind == "web" else kind)
    if lane:
        lane_params = {**base, **lane}
        if kind == "papers":
            # Titles are English; a Korean locale drags in unrelated Korean journals.
            lane_params.update(q=_latin_only(query), language="en")
        lane_requests.append(("kind", lane_params))
    if kind == "web" and base["language"] != "en" and not site:
        names, _ = _anchors(query)
        english = _english_query(query)
        if names and english != query:
            lane_requests.append(("english", {**base, "q": english, "language": "en"}))
    if hints.get("official") and not site:
        lane_requests.append(("official", {**base, "q": f"{_core_query(query)} site:go.kr"}))
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
        responses = await asyncio.gather(
            client.get(search_url, params=base),
            *(client.get(search_url, params=params) for _, params in lane_requests),
            return_exceptions=True,
        )
    general = responses[0]
    if isinstance(general, BaseException):
        raise general
    general.raise_for_status()
    hits: list[dict[str, str]] = []

    def collect(payload: dict[str, Any], *, lane: str = "", lane_query: str = "") -> None:
        # Over-fetch, then keep the best `count` after `_select`.
        for row in (payload.get("results") or [])[: count * 3]:
            hits.append(
                {
                    "title": row.get("title") or "",
                    "url": row.get("url") or "",
                    "snippet": row.get("content") or "",
                    "published": str(row.get("publishedDate") or "")[:10],
                    **({"lane": lane, "lane_query": lane_query} if lane else {}),
                }
            )

    for (tag, params), laned in zip(lane_requests, responses[1:], strict=True):
        if not isinstance(laned, BaseException) and laned.status_code < 400:
            collect(laned.json(), lane=tag, lane_query=str(params["q"]))
    collect(general.json())
    terms = _terms(query)
    # A `site:` lane answers with whatever the domain has; a hit sharing no
    # word with the question is that, not an answer.
    hits = [h for h in hits if h.get("lane") != "official" or _overlap(h, terms) > 0]
    return _select(hits, query, count)


async def _scrape(base_url: str, url: str) -> str:
    """Page body as Markdown through the shim; empty string on failure.

    The gateway replaces the Authorization header; the key is still sent for bare-shim deployments.
    """
    if not base_url:
        return ""
    # Search results and model-picked addresses pass through here too: nothing on the
    # deployment's own network is fetched on a reader's behalf.
    if reason := await netguard.refusal(url):
        log.info("scrape refused for %s: %s", logs.safe(url), reason)
        return ""
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
            response = await client.post(
                f"{base_url.rstrip('/')}/v1/scrape",
                headers={"Authorization": f"Bearer {settings.scraper_api_key}"},
                json={"url": url, "formats": ["markdown"]},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.info("scrape failed for %s: %s", logs.safe(url), logs.safe(exc))
        return ""
    data = payload.get("data") or payload
    return (data.get("markdown") or data.get("content") or "").strip()


#: Shared with callers outside the tool loop (shelf ingestion, `services.research`).
scrape = _scrape
searxng = _searxng


def _search_source_url(value: Any) -> str | None:
    """A structurally usable HTTP(S) reference; network access remains netguard's job."""
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or "\\" in url or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        # Accessing port validates nonnumeric and out-of-range ports.
        _ = parsed.port
    except ValueError:
        return None
    return url


async def web_search(args: dict[str, Any]) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        return ToolResult(content="오류: query 가 비었습니다.", failed=True)
    kind = str(args.get("kind") or "web")
    if kind not in ("web", *_LANES):
        kind = "web"
    if kind == "web" and _PAPER_CUES.search(query):
        # A paper question without the kind set: the science lane (arXiv,
        # Semantic Scholar, Crossref) answers it; the general lane gives blogs.
        kind = "papers"

    backends = await settings_store.tools_config()
    # Time-sensitive words get the news lane too; see `_searxng`.
    from app.services.context import needs_web_search

    hints = {k: args.get(k) for k in ("site", "time_range", "language", "official") if args.get(k)}
    try:
        hits = await _searxng(
            backends.search,
            query,
            settings.web_search_results,
            fresh=needs_web_search(query),
            kind=kind,
            hints=hints,
        )
    except (httpx.HTTPError, ValueError) as exc:
        return ToolResult(content=f"오류: 검색에 실패했습니다 ({exc}).", failed=True)
    hits = [
        {
            **hit,
            "url": url,
            "title": hit.get("title") if isinstance(hit.get("title"), str) else "",
            "snippet": hit.get("snippet") if isinstance(hit.get("snippet"), str) else "",
        }
        for hit in hits
        if isinstance(hit, dict) and (url := _search_source_url(hit.get("url")))
    ]
    if not hits:
        return ToolResult(
            content=f"'{query}' 에 대한 검색 결과가 없습니다.", detail="0개 결과", empty=True
        )
    if _off_topic(hits, query):
        return ToolResult(
            content=(
                f"'{query}' 검색 결과가 질문과 무관한 것뿐입니다 — 검색 엔진이 제대로 "
                "응답하지 않는 것 같습니다. 같은 검색을 되풀이하지 말고, 아는 것으로 답하되 "
                "검색으로 확인하지 못했다고 밝히세요."
            ),
            detail=f"{len(hits)}개 결과 · 모두 무관",
            empty=True,
        )

    # Top few read in full; the rest stay as titles the model can fetch by URL.
    bodies = await asyncio.gather(
        *(_scrape(backends.fetch, h["url"]) for h in hits[: settings.web_search_scrape])
    )

    lines = [f"'{query}' 검색 결과:\n"]
    usable_sources: list[str] = []
    for i, hit in enumerate(hits):
        dated = f"게시일 {hit['published']} · " if hit.get("published") else ""
        lines.append(f"[{i + 1}] {hit['title']}\n{hit['url']}\n{dated}{hit['snippet']}")
        body = bodies[i] if i < len(bodies) and isinstance(bodies[i], str) else ""
        if hit["snippet"].strip() or body.strip():
            usable_sources.append(hit["url"])
        if body:
            lines.append(f"본문 발췌:\n{_truncate(body, 4000)}")
        lines.append("")

    scraped = sum(1 for b in bodies if b)
    return ToolResult(
        content="\n".join(lines),
        detail=f"{len(hits)}개 결과 · {scraped}개 본문 읽음",
        # Link-only results remain useful for ordinary follow-up fetches, but
        # cannot release the current-fact gate by their heading or URL alone.
        search_evidence=SearchEvidence(tuple(usable_sources)) if usable_sources else None,
    )


async def fetch_url(args: dict[str, Any]) -> ToolResult:
    url = str(args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return ToolResult(content="오류: http(s) URL 이 필요합니다.", failed=True)
    # Told apart from an unreadable page so the model does not try the address again.
    if reason := await netguard.refusal(url):
        return ToolResult(content=f"오류: {reason} ({url})", failed=True)
    backends = await settings_store.tools_config()
    body = await _scrape(backends.fetch, url)
    if not body:
        return ToolResult(content=f"오류: {url} 을 읽지 못했습니다.", failed=True)
    return ToolResult(content=_truncate(body, 20_000), detail=f"{len(body):,}자")


# ── code execution ─────────────────────────────────────────────────────


async def execute_code(args: dict[str, Any]) -> ToolResult:
    code = str(args.get("code") or "")
    if not code.strip():
        return ToolResult(content="오류: code 가 비었습니다.", failed=True)
    backends = await settings_store.tools_config()
    if not backends.exec:
        return ToolResult(content="오류: 코드 실행이 설정되지 않았습니다.", failed=True)

    # The sandbox names it "py", not "python".
    lang = {"python": "py", "py": "py"}.get(str(args.get("language") or "python"), "py")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0)) as client:
            response = await client.post(
                f"{backends.exec.rstrip('/')}/exec",
                headers={"x-api-key": settings.code_interpreter_api_key},
                json={"code": code, "lang": lang},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        return ToolResult(content=f"오류: 코드 실행에 실패했습니다 ({exc}).", failed=True)

    stdout = (payload.get("stdout") or "").strip()
    stderr = (payload.get("stderr") or "").strip()
    parts = []
    if stdout:
        parts.append(f"stdout:\n{_truncate(stdout, 8000)}")
    if stderr:
        parts.append(f"stderr:\n{_truncate(stderr, 4000)}")
    if not parts:
        parts.append("실행되었지만 출력이 없습니다. 결과를 보려면 print() 를 쓰세요.")
    return ToolResult(content="\n\n".join(parts), failed=bool(stderr and not stdout))


# ── registry ───────────────────────────────────────────────────────────

WEB_SEARCH = Tool(
    name="web_search",
    description=(
        "웹을 검색하고 상위 결과의 본문을 읽어 옵니다. 최신 정보, 뉴스, 통계, "
        "모델이 모르는 사실을 확인할 때 사용하세요. 논문·학술 자료는 kind=papers, "
        "코드·라이브러리·오류 메시지는 kind=code, 시사·사건은 kind=news 로 검색하면 "
        "그 분야 엔진이 함께 답합니다. 공식 출처가 필요하면 site 나 official 을, "
        "최근 것만 필요하면 time_range 를, 해외 자료는 language=en 을 주세요."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "검색어. 자연어 질문보다 핵심 키워드가 낫습니다.",
            },
            "kind": {
                "type": "string",
                "enum": ["web", "news", "papers", "code"],
                "description": (
                    "검색 종류. web: 일반(기본). news: 뉴스·시사. papers: 논문·학술 "
                    "(Google Scholar, OpenAlex, arXiv 등). code: 개발 (GitHub, Stack Overflow 등)."
                ),
            },
            "site": {
                "type": "string",
                "description": "이 도메인 안에서만 찾습니다. 예: neurips.cc, kosaf.go.kr",
            },
            "official": {
                "type": "boolean",
                "description": "정부·공공기관(go.kr) 자료를 함께 찾습니다. 제도·신청·기한 질문에.",
            },
            "time_range": {
                "type": "string",
                "enum": ["day", "week", "month", "year"],
                "description": "이 기간 안의 자료만. 최신 소식은 week, 올해 제도는 year.",
            },
            "language": {
                "type": "string",
                "enum": ["ko", "en"],
                "description": "결과 언어. 해외 제품·논문·표준은 en.",
            },
        },
        "required": ["query"],
    },
    run=web_search,
    label="웹 검색 중",
    title="웹 검색",
)

FETCH_URL = Tool(
    name="fetch_url",
    description=(
        "특정 URL 의 본문을 마크다운으로 읽어 옵니다. 검색 결과의 출처를 직접 확인할 때 사용하세요."
    ),
    parameters={
        "type": "object",
        "properties": {"url": {"type": "string", "description": "읽을 페이지의 전체 URL"}},
        "required": ["url"],
    },
    run=fetch_url,
    label="문서 읽는 중",
    title="문서 읽기",
)

#: Geocoding (OpenStreetMap Nominatim reads Korean place names; Open-Meteo's own
#: geocoder does not) and the forecast itself. Both are keyless public services.
_GEOCODE_URL = "https://nominatim.openstreetmap.org/search"
_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_WEATHER_AGENT = "KloudChat/1.0 (weather tool)"
_WMO = {
    0: "맑음",
    1: "대체로 맑음",
    2: "구름 조금",
    3: "흐림",
    45: "안개",
    48: "안개",
    51: "약한 이슬비",
    53: "이슬비",
    55: "강한 이슬비",
    56: "어는 이슬비",
    57: "어는 이슬비",
    61: "약한 비",
    63: "비",
    65: "강한 비",
    66: "어는 비",
    67: "어는 비",
    71: "약한 눈",
    73: "눈",
    75: "강한 눈",
    77: "싸락눈",
    80: "약한 소나기",
    81: "소나기",
    82: "강한 소나기",
    85: "소낙눈",
    86: "강한 소낙눈",
    95: "뇌우",
    96: "우박 동반 뇌우",
    99: "강한 우박 동반 뇌우",
}
#: Beyond these, a raw date reads better than reaching for 글피/그글피.
_DAY_NAMES = ("오늘", "내일", "모레")
_WEEKDAYS = ("월", "화", "수", "목", "금", "토", "일")


def _sky(code: Any) -> str:
    try:
        return _WMO.get(int(code), "확인 불가")
    except (TypeError, ValueError):
        return "확인 불가"


def _day_label(i: int, iso_date: str) -> str:
    """`오늘(2026-09-11)` for the near days, `9월 15일(화)` past that."""
    if i < len(_DAY_NAMES):
        return f"{_DAY_NAMES[i]}({iso_date})"
    try:
        d = date.fromisoformat(iso_date)
    except ValueError:
        return iso_date
    return f"{d.month}월 {d.day}일({_WEEKDAYS[d.weekday()]})"


def format_weather(place: str, data: dict[str, Any]) -> str:
    """The forecast as the model reads it: a numbered source line, the current
    conditions, then one line per day."""
    current = data.get("current") or {}
    daily = data.get("daily") or {}
    lat, lon = data.get("latitude"), data.get("longitude")
    lines = [
        f"[1] Open-Meteo 날씨 예보 · {place}",
        f"https://open-meteo.com/en/docs#latitude={lat}&longitude={lon}",
        f"기준 시각: {current.get('time', '?')} ({data.get('timezone', '')})",
        (
            f"현재: {current.get('temperature_2m')}°C"
            f"(체감 {current.get('apparent_temperature')}°C), {_sky(current.get('weather_code'))}, "
            f"습도 {current.get('relative_humidity_2m')}%, "
            f"바람 {current.get('wind_speed_10m')} km/h, "
            f"강수 {current.get('precipitation')} mm"
        ),
    ]
    for i, day in enumerate(daily.get("time") or []):

        def at(key: str, i: int = i) -> Any:
            values = daily.get(key) or []
            return values[i] if i < len(values) else "?"

        lines.append(
            f"{_day_label(i, day)}: {_sky(at('weather_code'))}, "
            f"최고 {at('temperature_2m_max')}°C / 최저 {at('temperature_2m_min')}°C, "
            f"강수 확률 {at('precipitation_probability_max')}%"
        )
    return "\n".join(lines)


async def weather(args: dict[str, Any]) -> ToolResult:
    place = str(args.get("location") or "").strip()
    if not place:
        return ToolResult(content="오류: location 이 비었습니다.", failed=True)
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            geo = await client.get(
                _GEOCODE_URL,
                params={"q": place, "format": "jsonv2", "limit": 5, "accept-language": "ko"},
                headers={"User-Agent": _WEATHER_AGENT},
            )
            geo.raise_for_status()
            hits = geo.json()
            if not hits:
                return ToolResult(
                    content=(
                        f"오류: '{place}' 의 위치를 찾지 못했습니다. "
                        "시·구 이름으로 다시 시도하세요."
                    ),
                    failed=True,
                )
            # Nominatim's own top hit is relevance-ranked, not importance-ranked:
            # a minor stop or shop sharing the name can outrank the place itself
            # (a "후쿠오카" search once returned a Toyama railway stop ahead of
            # anything in Fukuoka). Importance among the top few candidates is
            # the closer proxy for "the place a person means".
            hit = max(hits, key=lambda h: float(h.get("importance") or 0))
            forecast = await client.get(
                _FORECAST_URL,
                params={
                    "latitude": float(hit["lat"]),
                    "longitude": float(hit["lon"]),
                    "current": (
                        "temperature_2m,apparent_temperature,relative_humidity_2m,"
                        "precipitation,weather_code,wind_speed_10m"
                    ),
                    "daily": (
                        "weather_code,temperature_2m_max,temperature_2m_min,"
                        "precipitation_probability_max"
                    ),
                    "timezone": "auto",
                    # Open-Meteo serves up to 16 without a key; 10 covers the
                    # travel-planning window a "이번 주말" / "다음 주" question
                    # asks about without reaching into the unreliable tail.
                    "forecast_days": 10,
                },
            )
            forecast.raise_for_status()
            data = forecast.json()
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        return ToolResult(
            content=f"오류: 날씨를 가져오지 못했습니다 ({exc.__class__.__name__}).", failed=True
        )
    name = str(hit.get("display_name") or place)
    return ToolResult(content=format_weather(name, data), detail=name.split(",")[0].strip())


WEATHER = Tool(
    name="weather",
    description=(
        "특정 지역의 현재 날씨와 최대 10일 예보를 가져옵니다. 날씨·기온·비나 눈 소식·우산 여부를 "
        "물으면 web_search 대신 이 도구를 쓰세요."
    ),
    parameters={
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "지역 이름. 예: 분당, 성남시, 서울 강남구, Tokyo",
            }
        },
        "required": ["location"],
    },
    run=weather,
    label="날씨 확인 중",
    title="날씨",
)

EXECUTE_CODE = Tool(
    name="execute_code",
    description=(
        "샌드박스에서 Python 코드를 실행합니다. 계산, 수식 전개(sympy), 데이터 처리에 "
        "쓰세요. 결과는 반드시 print() 로 출력해야 보입니다. 네트워크는 막혀 있습니다."
    ),
    parameters={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "실행할 코드. 출력은 print() 로."},
            "language": {"type": "string", "enum": ["python"], "default": "python"},
        },
        "required": ["code"],
    },
    run=execute_code,
    label="코드 실행 중",
    title="코드 실행",
)

#: Report and deck are excluded: they have their own pipelines.
_ARTIFACT_KINDS = {"html", "code"}

#: Tags that only mark up running text; HTML using nothing else is treated as prose.
_PROSE_TAGS = frozenset(
    {
        "p",
        "br",
        "hr",
        "span",
        "a",
        "b",
        "i",
        "u",
        "em",
        "strong",
        "small",
        "ul",
        "ol",
        "li",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
    }
)

#: Languages that name prose; only honoured when the model states one.
_PROSE_LANGUAGES = frozenset({"text", "txt", "plain", "md", "markdown"})

#: Prose shorter than this is returned as an answer, not an artifact.
_PROSE_MAX_CHARS = 1000

#: Below this the model is told to repeat the artifact body in the answer.
_ECHO_MAX_CHARS = 600

_TAG_NAME = re.compile(r"<\s*/?\s*([A-Za-z][\w-]*)")
_ANY_TAG = re.compile(r"<[^>]*>")


def _visible_length(kind: str, content: str) -> int:
    """Visible character count, markup and entities discounted."""
    text = _ANY_TAG.sub(" ", content) if kind == "html" else content
    return len(" ".join(unescape(text).split()))


#: Words in the user's request that ask for a file or document.
_FILE_WORDS = re.compile(
    r"파일|문서로|문서를|다운로드|내려받|내보내|첨부|저장해|"
    r"\.(?:txt|md|docx|pptx|xlsx|csv|pdf|html|ya?ml|json)\b|"
    r"\bfile\b|\bdocument\b|\bdownload\b|\bexport\b|\battach",
    re.I,
)


def _asked_for_a_file(request: str) -> bool:
    """Whether the user's own words asked for a file; `userRequested` alone is not trusted."""
    return bool(_FILE_WORDS.search(request or ""))


def _is_prose(kind: str, content: str, language: str) -> bool:
    """Whether the payload is writing to be read rather than a file a program uses."""
    if kind == "code":
        return language in _PROSE_LANGUAGES
    if "<!doctype" in content.lower():
        return False
    return {tag.group(1).lower() for tag in _TAG_NAME.finditer(content)} <= _PROSE_TAGS


async def create_artifact(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Records an artifact for the turn to store once it finishes."""
    kind = str(args.get("kind") or "").strip().lower()
    title = str(args.get("title") or "").strip()
    content = str(args.get("content") or "")
    language = str(args.get("language") or "").strip().lower()

    if kind not in _ARTIFACT_KINDS:
        return ToolResult(
            content=f"오류: kind 는 {' 또는 '.join(sorted(_ARTIFACT_KINDS))} 여야 합니다.",
            failed=True,
        )
    if not content.strip():
        return ToolResult(content="오류: content 가 비어 있습니다.", failed=True)
    if not title:
        return ToolResult(content="오류: title 이 필요합니다.", failed=True)

    # "html" with no tags is Markdown; relabel rather than refuse.
    if kind == "html" and not _TAG_NAME.search(content):
        kind = "code"
        language = "markdown"

    visible = _visible_length(kind, content)
    # Short prose is sent back to the answer unless the user's words asked for a file.
    # Not `failed`: an errored step marks the whole turn 중단됨.
    requested = bool(args.get("userRequested")) and _asked_for_a_file(ctx.request)
    if not requested and visible < _PROSE_MAX_CHARS and _is_prose(kind, content, language):
        return ToolResult(
            content=(
                f"'{title}' 은 문서로 만들지 않았습니다. 실행하거나 다른 프로그램이 "
                f"읽어 갈 파일이 아니라 {visible}자 남짓한 글이라, 옆 패널에 두면 "
                "읽으려고 패널을 여는 수고만 늘어납니다. 본문을 답변에 그대로 "
                "적어 주고, 끝에 한 줄로 파일이나 문서로 따로 만들어 드릴 수도 "
                "있다고 덧붙이세요. 사용자가 그렇게 해 달라고 하면 그때 "
                "userRequested 를 true 로 두고 다시 부르세요."
            ),
            detail="답변에 직접 적기",
        )

    ctx.pending_artifacts.append(
        {
            "kind": kind,
            "title": title[:200],
            "data": {
                "kind": kind,
                "content": content,
                "language": "html" if kind == "html" else (language or "text"),
            },
        }
    )
    if visible < _ECHO_MAX_CHARS:
        carry = (
            "짧으니 답변에도 본문을 그대로 옮겨 적으세요. 패널은 내보내고 버전을 "
            "남기려고 있는 것이고, 읽는 일은 대화 안에서 끝나야 합니다."
        )
    else:
        carry = (
            "길이가 있으니 본문을 다시 옮길 필요는 없지만, 무엇을 만들었고 그 안에 "
            "무엇이 들어 있는지는 답변에 적으세요. '만들었습니다' 한 줄로 끝내지 "
            "마세요."
        )
    return ToolResult(
        content=f"'{title}' 문서를 만들어 사용자 화면에 띄웠습니다. {carry}",
        detail=title,
    )


CREATE_ARTIFACT = Tool(
    name="create_artifact",
    description=(
        "완성된 결과물을 별도 문서로 만들어 사용자 화면 옆에 띄웁니다. 기준은 "
        "길이가 아니라 쓰임새입니다. 대화 밖으로 나가 파일로 저장되거나 실행·"
        "렌더링·불러오기 되는 것만 문서입니다. 웹페이지, 스크립트, 설정 파일, "
        "데이터 파일이 그렇고, 네 줄짜리 docker-compose.yml 도 문서입니다. "
        "읽고 나면 쓰임이 끝나는 글은 사용자가 '만들어 달라'고 했어도 답변에 "
        "그대로 적으세요. 메일 초안, 요약, 번역, 개요, 사과문, 회신 문구가 "
        "그렇습니다. 예외는 절이 여러 개로 나뉜 긴 문서처럼 대화에 그대로 실으면 "
        "읽기 어려운 분량뿐입니다. 애매하면 이렇게 물어 보세요. 사용자가 이 "
        "결과를 다른 프로그램에 넣습니까, 읽고 끝냅니까. 읽고 끝나면 답변입니다. "
        "설명을 위한 짧은 예시 코드에도 쓰지 마세요. 표도 마찬가지입니다 — 「표로 "
        "정리해 달라」는 답변 안의 마크다운 표를 뜻하지 HTML 문서를 뜻하지 않습니다. "
        "앞선 답을 표·목록·다른 길이로 바꿔 달라는 후속 요청은 늘 답변입니다."
    ),
    parameters={
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["html", "code"],
                "description": (
                    "html 은 브라우저에서 미리보기가 되는 한 페이지, code 는 그 외 소스."
                ),
            },
            "title": {"type": "string", "description": "문서 이름. 파일명처럼 짧게."},
            "content": {
                "type": "string",
                "description": (
                    "문서 전체 내용. 마크다운 코드펜스로 감싸지 마세요. "
                    'kind=html일 때 미리보기는 sandbox="allow-scripts"입니다. '
                    "form submit과 이를 통한 외부 요청은 차단되므로 "
                    'type="button"과 click/input 이벤트로 계산·검증을 구현하세요. '
                    "localStorage나 부모 창(parent) 접근에 의존하지 말고, "
                    "내려받은 파일도 작동하도록 CSS/JS를 같은 문서에 담으세요."
                ),
            },
            "language": {
                "type": "string",
                "description": "kind 가 code 일 때의 언어 (python, bash, yaml 등).",
            },
            "userRequested": {
                "type": "boolean",
                "description": (
                    "사용자가 **파일이나 문서 자체를** 달라고 했을 때만 true. "
                    "'메일 초안 써 줘' 는 글을 부탁한 것이지 파일을 부탁한 것이 "
                    "아니므로 false 입니다. '그 메일 txt 파일로 만들어 줘' 가 "
                    "true 입니다. 짧은 글은 이 값이 true 이고 사용자가 실제로 "
                    "파일을 말했을 때만 문서가 됩니다 — 스스로 판단해 켜도 "
                    "되돌아옵니다."
                ),
            },
        },
        "required": ["kind", "title", "content"],
    },
    run=create_artifact,
    label="아티팩트 만드는 중",
    title="아티팩트 생성",
    read_only=False,
    wants_context=True,
)


#: One per series, in order; assigned here rather than asked of the model.
_SERIES_COLOURS = ("#5b5bd6", "#e8834a", "#2ea88a", "#c74e8e", "#6b7280")


def _chart_table(series: list[dict], x_label: str) -> dict:
    """Table rows derived from the same points the chart renders."""
    keys: list[str] = []
    for one in series:
        for point in one["points"]:
            if point["x"] not in keys:
                keys.append(point["x"])
    rows: list[list] = []
    for key in keys:
        row: list = [key]
        for one in series:
            match = next((p["y"] for p in one["points"] if p["x"] == key), "")
            row.append(match)
        rows.append(row)
    return {"columns": [x_label or "항목", *[s["name"] for s in series]], "rows": rows}


async def create_chart(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Records a chart artifact for the turn to store once it finishes.

    Colours are assigned and the table derived here, not taken from the model.
    """
    chart_type = str(args.get("chartType") or "bar").strip().lower()
    if chart_type not in ("bar", "line", "stacked"):
        chart_type = "bar"
    title = str(args.get("title") or "").strip()
    if not title:
        return ToolResult(content="오류: title 이 필요합니다.", failed=True)

    raw = args.get("series")
    if not isinstance(raw, list) or not raw:
        return ToolResult(content="오류: series 가 비어 있습니다.", failed=True)

    series: list[dict] = []
    for index, item in enumerate(raw[: len(_SERIES_COLOURS)]):
        if not isinstance(item, dict):
            continue
        points = []
        for point in item.get("points") or []:
            if not isinstance(point, dict):
                continue
            try:
                value = float(point.get("y"))
            except (TypeError, ValueError):
                # Dropped rather than plotted as zero.
                continue
            label = str(point.get("x") or "").strip()
            if label:
                points.append({"x": label[:40], "y": value})
        if points:
            series.append(
                {
                    "name": str(item.get("name") or f"계열 {index + 1}").strip()[:40],
                    "color": _SERIES_COLOURS[index],
                    "points": points[:40],
                }
            )

    if not series:
        return ToolResult(
            content="오류: 그릴 수 있는 값이 없습니다. 각 point 는 x(이름)와 y(숫자)가 필요합니다.",
            failed=True,
        )

    x_label = str(args.get("xLabel") or "").strip()[:40]
    ctx.pending_artifacts.append(
        {
            "kind": "chart",
            "title": title[:200],
            "data": {
                "kind": "chart",
                "chartType": chart_type,
                "caption": str(args.get("caption") or "").strip()[:300],
                "xLabel": x_label,
                "yLabel": str(args.get("yLabel") or "").strip()[:40],
                "series": series,
                "table": _chart_table(series, x_label),
                "sourceFile": str(args.get("sourceFile") or "").strip()[:200],
            },
        }
    )
    return ToolResult(
        content=(
            f"'{title}' 차트를 만들었습니다. 사용자 화면에 이미 열려 있으니 수치를 다시 "
            "나열하지 말고, 이 차트가 무엇을 보여 주는지만 한두 문장으로 설명하세요."
        ),
        detail=title,
    )


CREATE_CHART = Tool(
    name="create_chart",
    description=(
        "수치를 막대/선 그래프로 그려 사용자 화면 옆에 띄웁니다. 비교·추이·분포처럼 "
        "값이 여러 개인 결과를 보여 줄 때 쓰세요. 표로 충분한 두세 개 값이나, "
        "근거 없이 지어낸 수치에는 쓰지 마세요."
    ),
    parameters={
        "type": "object",
        "properties": {
            "chartType": {
                "type": "string",
                "enum": ["bar", "line", "stacked"],
                "description": "bar 는 비교, line 은 시간에 따른 추이.",
            },
            "title": {"type": "string", "description": "차트 이름. 짧게."},
            "caption": {"type": "string", "description": "이 차트가 무엇을 보여 주는지 한 줄."},
            "xLabel": {"type": "string", "description": "가로축이 무엇인지 (연도, 모델 등)."},
            "yLabel": {"type": "string", "description": "세로축의 단위 (건, %, 초 등)."},
            "sourceFile": {
                "type": "string",
                "description": "수치의 출처. 첨부 파일 이름이나 자료 이름.",
            },
            "series": {
                "type": "array",
                "description": "계열 목록. 하나면 단일 그래프, 여럿이면 나란히 그립니다.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "범례에 쓸 이름."},
                        "points": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "x": {"type": "string", "description": "가로축 값의 이름."},
                                    "y": {"type": "number", "description": "숫자 값."},
                                },
                                "required": ["x", "y"],
                            },
                        },
                    },
                    "required": ["name", "points"],
                },
            },
        },
        "required": ["title", "series"],
    },
    run=create_chart,
    label="차트 그리는 중",
    title="차트 그리기",
    read_only=False,
    wants_context=True,
)


_NOTE_MAX_CHARS = 4000


async def share_note(args: dict, ctx: ToolContext) -> ToolResult:
    """Queues a shared note for later turns; scope is the project if any, else this session.

    The same `key` overwrites an earlier note.
    """
    title = str(args.get("title") or "").strip()
    body = str(args.get("body") or "").strip()
    if not title:
        return ToolResult(content="오류: title 이 필요합니다.", failed=True)
    if not body:
        return ToolResult(content="오류: body 가 비어 있습니다.", failed=True)
    if len(body) > _NOTE_MAX_CHARS:
        return ToolResult(
            content=(
                f"오류: body 가 {_NOTE_MAX_CHARS}자를 넘습니다. 다음 단계가 바로 쓸 수 "
                "있는 결론만 남기고, 근거 전체는 답변이나 아티팩트에 두세요."
            ),
            failed=True,
        )

    key = str(args.get("key") or "").strip() or title
    ctx.pending_notes.append(
        {
            "key": key[:120],
            "title": title[:120],
            "body": body,
            "author": ctx.agent_name,
        }
    )
    where = "이 프로젝트의 모든 대화와 에이전트" if ctx.project_id else "이 대화의 다음 요청"
    return ToolResult(
        content=(
            f"'{title}' 을 공유 메모에 남겼습니다. {where}가 다음 요청부터 이 내용을 "
            "함께 받습니다. 사용자에게는 무엇을 남겼는지 한 줄로 알려 주세요."
        ),
        detail=title,
    )


SHARE_NOTE = Tool(
    name="share_note",
    description=(
        "다음 단계나 다른 에이전트가 이어받아야 할 결론을 공유 메모에 남깁니다. "
        "프로젝트 안에서는 그 프로젝트의 모든 대화와 에이전트가, 프로젝트 밖에서는 "
        "이 대화의 다음 요청이 이 내용을 자동으로 받습니다. "
        "조사 결과, 확정된 사실, 정해진 방침, 다음 사람이 지켜야 할 제약처럼 "
        "이 요청이 끝난 뒤에도 유효한 것만 남기세요. "
        "이번 답변으로 끝나는 설명이나 사용자에게 할 말은 남기지 마세요. "
        "같은 key 로 다시 부르면 이전 내용을 덮어씁니다."
    ),
    parameters={
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "한 줄 제목. 목록에서 이것만 보고 고를 수 있게.",
            },
            "body": {
                "type": "string",
                "description": (
                    "다음 단계가 그대로 쓸 수 있는 결론. 과정이 아니라 결과를 적으세요."
                ),
            },
            "key": {
                "type": "string",
                "description": (
                    "고쳐 쓸 수 있게 하는 이름. 같은 key 는 덮어씁니다. 비우면 title 을 씁니다."
                ),
            },
        },
        "required": ["title", "body"],
    },
    run=share_note,
    label="공유 메모 남기는 중",
    title="공유 메모",
    read_only=False,
    wants_context=True,
)


async def available_builtins(web_search_enabled: bool) -> list[Tool]:
    """Local tools plus configured backends; web search needs the per-turn toggle too."""
    backends = await settings_store.tools_config()
    tools: list[Tool] = [CALCULATE, CHECK_NCS_ANSWER]
    if backends.fetch:
        tools.append(FETCH_URL)
        if web_search_enabled and backends.search:
            # Search without fetch yields snippets only.
            tools.insert(0, WEB_SEARCH)
    if web_search_enabled:
        # External like a fetch, so it follows the same toggle (and strict-local drops it).
        tools.append(WEATHER)
    if backends.exec:
        tools.append(EXECUTE_CODE)
    tools.append(CREATE_ARTIFACT)
    tools.append(CREATE_CHART)
    tools.append(SHARE_NOTE)
    return tools


def knowledge_tool(documents: list[tuple[str, str, str | None]], collection: str = "") -> Tool:
    """Search tool over preloaded documents — an agent's knowledge, a conversation's
    uploads — since tools hold no DB session.

    `collection`: vector index collection merged in when set.
    """

    # The description lists each document's headings so the model knows what the shelf covers.
    def _outline(text: str, limit: int = 12) -> str:
        seen: list[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("#"):
                continue
            heading = stripped.lstrip("#").strip()
            if heading and heading not in seen:
                seen.append(heading)
            if len(seen) >= limit:
                break
        if not seen:
            first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
            seen = [first[:60]] if first else []
        return f" — {' / '.join(seen)}" if seen else ""

    listed = "; ".join(f"{name}{_outline(text)}" for name, text, _ in documents[:6])
    more = "" if len(documents) <= 6 else f" 외 {len(documents) - 6}건"

    async def run(args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(content="검색어가 비어 있습니다.", failed=True)
        passages, ranked = knowledge.gather(documents, query)
        # Vector hits are merged with, not preferred over, the lexical scorer's.
        if collection and ranked:
            hits = await index_client.search(collection=collection, query=query)
            if hits:
                passages = knowledge.merge(hits, passages)
        if not passages:
            return ToolResult(
                content=(
                    f"자료 {len(documents)}건을 찾아봤지만 '{query}' 와 겹치는 대목이 "
                    "없습니다. 자료에 없는 내용을 지어내지 말고, 자료에 없다고 답하세요."
                ),
                detail="해당 없음",
            )
        body = knowledge.render(passages)
        detail = f"{len(passages)}개 대목" if ranked else f"자료 {len(passages)}건 전문"
        return ToolResult(content=body, detail=detail)

    return Tool(
        name="search_knowledge",
        description=(
            "이 대화나 에이전트에 첨부된 자료 안에서 검색합니다. 붙어 있는 자료: "
            f"{listed}{more}. "
            "위 목록은 각 자료의 목차일 뿐 내용이 아닙니다. 목차만 보고 "
            "'자료에 없다'고 판단하지 말고, 이 자료가 다룰 만한 주제이면 반드시 "
            "먼저 이 도구를 부르세요. 기억에 의존해 답하지 마세요. 웹 검색이 아니라 "
            "첨부 자료 전용입니다."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "찾을 내용. 문서에 쓰였을 법한 낱말로 적으세요.",
                }
            },
            "required": ["query"],
        },
        run=run,
        label="자료 찾는 중",
        title="자료 찾기",
    )
