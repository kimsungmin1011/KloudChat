"""Edited-section HTML (`format: "html"`) back to the Markdown the exporters read.

The vocabulary is `design_templates._ALLOWED_TAGS`; `design_templates.sanitise`
runs first. Markdown → HTML is the browser's job.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html import unescape
from html.parser import HTMLParser

#: Block tags that end a paragraph; everything else is inline.
_BLOCK = re.compile(
    r"</?(p|div|section|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|figure"
    r"|figcaption|dl|dt|dd|hr|br)\b[^>]*>",
    re.I,
)
_TAG = re.compile(r"<[^>]+>")
#: `<strong>가</strong>` → `**가**`. Nested emphasis keeps only the outer mark.
_EMPHASIS = (
    (re.compile(r"<(strong|b)\b[^>]*>(.*?)</\1\s*>", re.S | re.I), r"**\2**"),
    (re.compile(r"<(em|i)\b[^>]*>(.*?)</\1\s*>", re.S | re.I), r"*\2*"),
    (re.compile(r"<code\b[^>]*>(.*?)</code\s*>", re.S | re.I), r"`\1`"),
)


@dataclass(slots=True)
class Cell:
    """One table cell; `text` may hold newlines, spans are what GFM cannot say."""

    text: str
    colspan: int = 1
    rowspan: int = 1


@dataclass(slots=True)
class Grid:
    """A table as anchor cells: each row holds only the cells that begin in it.

    Cells covered by a span are not repeated, matching how docx, PDF and OWPML
    describe a merge.
    """

    rows: list[list[Cell]] = field(default_factory=list)

    @property
    def width(self) -> int:
        """Column count, walked with span occupancy rather than the widest anchor row."""
        taken: set[tuple[int, int]] = set()
        width = 0
        for index, row in enumerate(self.rows):
            column = 0
            for cell in row:
                while (index, column) in taken:
                    column += 1
                for down in range(cell.rowspan):
                    for across in range(cell.colspan):
                        taken.add((index + down, column + across))
                column += cell.colspan
            width = max(width, column)
        return width

    def flat(self, newline: str = " ") -> list[list[str]]:
        """Plain rows: text in the anchor cell, covered cells empty, newlines replaced."""
        width = self.width
        out: list[list[str]] = []
        taken: set[tuple[int, int]] = set()
        for index, row in enumerate(self.rows):
            while len(out) <= index:
                out.append([""] * width)
            column = 0
            for cell in row:
                while (index, column) in taken:
                    column += 1
                for down in range(cell.rowspan):
                    while len(out) <= index + down:
                        out.append([""] * width)
                    for across in range(cell.colspan):
                        taken.add((index + down, column + across))
                if column < width:
                    out[index][column] = cell.text.replace("\n", newline)
                column += cell.colspan
        return out


_FORMAT_BLOCKS = {"p", "h3", "h4", "li", "blockquote"}
_FORMAT_INLINE = {"strong", "b", "em", "i", "u", "s", "strike", "span", "code"}


def _style_map(value: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for declaration in value.split(";"):
        if ":" not in declaration:
            continue
        name, setting = declaration.split(":", 1)
        name, setting = name.strip().lower(), setting.strip()
        if (
            name
            in {
                "font-size",
                "font-family",
                "font-weight",
                "font-style",
                "text-align",
                "text-decoration",
                "color",
                "background-color",
                "line-height",
            }
            and setting
        ):
            out[name] = setting
    return out


class _FormatReader(HTMLParser):
    """Prose blocks as block styles and inline runs: formatting Markdown cannot carry."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict] = []
        self.block: dict | None = None
        self.styles: list[dict[str, str]] = [{}]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = {name.lower(): value or "" for name, value in attrs}
        style = _style_map(attributes.get("style", ""))
        if tag in _FORMAT_BLOCKS and self.block is None:
            self.block = {
                "tag": tag,
                "style": style,
                "runs": [],
                "text": "",
            }
            self.styles = [
                {
                    key: value
                    for key, value in style.items()
                    if key not in {"text-align", "line-height"}
                }
            ]
            return
        if tag in _FORMAT_INLINE and self.block is not None:
            merged = dict(self.styles[-1])
            merged.update(style)
            if tag in {"strong", "b"}:
                merged["font-weight"] = "bold"
            if tag in {"em", "i"}:
                merged["font-style"] = "italic"
            if tag == "u":
                merged["text-decoration"] = "underline"
            if tag in {"s", "strike"}:
                merged["text-decoration"] = "line-through"
            self.styles.append(merged)
        elif tag == "br" and self.block is not None:
            self.handle_data("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _FORMAT_INLINE and self.block is not None and len(self.styles) > 1:
            self.styles.pop()
        if tag in _FORMAT_BLOCKS and self.block is not None and self.block["tag"] == tag:
            if self.block["text"].strip():
                self.blocks.append(self.block)
            self.block = None
            self.styles = [{}]

    def handle_data(self, data: str) -> None:
        if self.block is None or not data:
            return
        style = dict(self.styles[-1])
        runs = self.block["runs"]
        if runs and runs[-1]["style"] == style:
            runs[-1]["text"] += data
        else:
            runs.append({"text": data, "style": style})
        self.block["text"] += data


def formatted_blocks(fragment: str) -> list[dict]:
    """Ordinary editable prose blocks with the presentation a person set."""
    if not fragment or "<" not in fragment:
        return []
    reader = _FormatReader()
    reader.feed(fragment)
    reader.close()
    return reader.blocks


def _span(markup: str, name: str) -> int:
    """A `colspan`/`rowspan` attribute, clamped to something a page can hold."""
    found = re.search(rf'{name}\s*=\s*["\']?(\d+)', markup, re.I)
    return max(1, min(int(found.group(1)), 40)) if found else 1


def _cell_text(body: str) -> str:
    """One cell's text, keeping the line breaks the writer put in it."""
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
    body = re.sub(r"</(p|div|li)\s*>", "\n", body, flags=re.I)
    lines = [_inline(line) for line in body.split("\n")]
    return "\n".join(line for line in lines if line)


def _grid(markup: str) -> Grid:
    """One `<table>` as a `Grid`."""
    grid = Grid()
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr\s*>", markup, re.S | re.I):
        cells = [
            Cell(_cell_text(body), _span(open_tag, "colspan"), _span(open_tag, "rowspan"))
            for open_tag, body in re.findall(r"<t[hd]\b([^>]*)>(.*?)</t[hd]\s*>", row, re.S | re.I)
        ]
        grid.rows.append(cells)
    # An empty anchor row can be covered by a rowspan that starts above it.
    # Keep the writer's row positions, including ordinary empty rows.
    return grid


def grids(fragment: str) -> list[Grid]:
    """Every table in an HTML body, in order; exporters match them to GFM tables by position."""
    found = re.findall(r"<table\b.*?</table\s*>", fragment, re.S | re.I)
    return [_grid(markup) for markup in found]


def _inline(fragment: str) -> str:
    """One run of inline markup as Markdown text."""
    text = fragment
    for pattern, replacement in _EMPHASIS:
        text = pattern.sub(replacement, text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = _TAG.sub("", text)
    return re.sub(r"[ \t]+", " ", unescape(text)).strip()


def _table(markup: str) -> str:
    """A table as a GFM table, or `''` when it has no rows. Cell line breaks become `<br>`."""
    rows = _grid(markup).flat(newline="<br>")
    if not any(cell for row in rows for cell in row):
        return ""
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    head, *body = padded
    lines = [
        "| " + " | ".join(cell.replace("|", "\\|") for cell in head) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines.extend("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in body)
    return "\n".join(lines)


#: List open/close edges; group 1 is `/` on a close, so nesting can be counted.
_LIST_EDGE = re.compile(r"<(/?)(ul|ol)\b[^>]*>", re.I)
#: The same for `<div>`, for the KPI strip.
_DIV_EDGE = re.compile(r"<(/?)div\b[^>]*>", re.I)
_ITEM_OPEN = re.compile(r"<li\b[^>]*>", re.I)


def _items(markup: str) -> list[tuple[str, str]]:
    """`(text, nested)` for each item of the outermost list in `markup`.

    Nesting is counted, not regex-matched. The fragment may be truncated
    (`sanitise` does not balance tags); a list that never closes runs to the end.
    """
    opened = markup.index(">") + 1
    depth = 1
    stop = len(markup)
    for edge in _LIST_EDGE.finditer(markup, opened):
        depth += -1 if edge.group(1) else 1
        if depth == 0:
            stop = edge.start()
            break
    body = markup[opened:stop]
    out: list[tuple[str, str]] = []
    starts = [m.end() for m in _ITEM_OPEN.finditer(body) if _depth(body[: m.start()]) == 0]
    for index, start in enumerate(starts):
        stop = _item_end(body, start, starts[index + 1] if index + 1 < len(starts) else len(body))
        chunk = body[start:stop]
        nested = _LIST_EDGE.search(chunk)
        cut = nested.start() if nested else len(chunk)
        out.append((chunk[:cut], chunk[cut:]))
    return out


def _depth(text: str) -> int:
    """How many lists are open at the end of `text`."""
    return sum(-1 if edge.group(1) else 1 for edge in _LIST_EDGE.finditer(text))


def _item_end(body: str, start: int, limit: int) -> int:
    """Where this item's own content ends — its `</li>`, at nesting depth zero."""
    for close in re.finditer(r"</li\s*>", body[start:limit], re.I):
        if _depth(body[start : start + close.start()]) == 0:
            return start + close.start()
    return limit


def _list(markup: str, ordered: bool, depth: int = 0) -> str:
    """A list as Markdown lines, sub-lists indented two spaces per level."""
    lines: list[str] = []
    pad = "  " * depth
    number = 0
    for text, nested in _items(markup):
        item = _inline(text)
        if item:
            number += 1
            lines.append(f"{pad}{number}. {item}" if ordered else f"{pad}- {item}")
        for inner in _sublists(nested):
            drawn = _list(inner, inner[:3].lower().startswith("<ol"), depth + 1)
            if drawn:
                lines.append(drawn)
    return "\n".join(lines)


def _sublists(markup: str) -> list[str]:
    """The lists directly inside one item, each whole."""
    out: list[str] = []
    while (opened := _LIST_EDGE.search(markup)) and not opened.group(1):
        start = opened.start()
        depth = 0
        for edge in _LIST_EDGE.finditer(markup, start):
            depth += -1 if edge.group(1) else 1
            if depth == 0:
                out.append(markup[start : edge.end()])
                markup = markup[edge.end() :]
                break
        else:
            out.append(markup[start:])
            break
    return out


#: One top-level construct. Order matters: structured blocks (page break, KPI
#: strip, steps, cards, callout, diagram, chart, footnote) before the plain
#: table, list, heading and figure they are built from. The KPI strip and the
#: lists match their opening tag only; `_balanced` finds where they close.
_CONSTRUCT = re.compile(
    r"<div\b[^>]*\bdata-page-break=(?:\"true\"|'true'|true)[^>]*>\s*</div\s*>"
    r"|<div\b[^>]*\bclass=\"[^\"]*\bkpi\b[^\"]*\"[^>]*>"
    r"|<ol\b[^>]*\bclass=\"[^\"]*\bsteps\b[^\"]*\"[^>]*>.*?</ol\s*>"
    r"|<section\b[^>]*\bclass=\"[^\"]*\bcards\b[^\"]*\"[^>]*>.*?</section\s*>"
    r"|<section\b[^>]*\bclass=\"[^\"]*\bcallout\b[^\"]*\"[^>]*>.*?</section\s*>"
    r"|<figure\b[^>]*\bclass=\"[^\"]*\bdiagram\b[^\"]*\"[^>]*>.*?</figure\s*>"
    r"|<figure\b[^>]*\bclass=\"[^\"]*\bchart\b[^\"]*\"[^>]*>.*?</figure\s*>"
    r"|<small\b[^>]*>.*?</small\s*>"
    r"|<table\b.*?</table\s*>"
    r"|<ul\b"
    r"|<ol\b"
    r"|<blockquote\b.*?</blockquote\s*>"
    r"|<h[1-6]\b.*?</h[1-6]\s*>"
    r"|<figure\b.*?</figure\s*>"
    r"|<img\b[^>]*>"
    r"|<hr\s*/?>",
    re.S | re.I,
)


def _render(match: re.Match[str], notes: int = 0) -> str:
    markup = match.group(0)
    lowered = markup[:12].lower()
    if re.search(r"\bdata-page-break=(?:\"true\"|'true'|true)", markup, re.I):
        # The Pandoc page-break comment: inert in Markdown readers, kept by exporters.
        return "<!-- pagebreak -->"
    if _KPI_OPEN.match(markup):
        return _pairs_fence("kpi", markup, r"<div\b[^>]*>(.*?)</div\s*>")
    if _STEPS_OPEN.match(markup):
        return _pairs_fence("steps", markup, r"<li\b[^>]*>(.*?)</li\s*>")
    if _CARDS_OPEN.match(markup):
        return _cards_fence(markup)
    if _CALLOUT_OPEN.match(markup):
        return _callout_fence(markup)
    if _DIAGRAM_OPEN.match(markup):
        return _diagram_fence(markup)
    if _CHART_OPEN.match(markup):
        found = _DIAGRAM_SOURCE.search(markup)
        source = html.unescape(found.group(1)[1:-1]).strip() if found else ""
        return "```chart\n" + source + "\n```" if source else ""
    if lowered.startswith("<small"):
        return _note(markup, notes)
    if lowered.startswith("<table"):
        return _table(markup)
    if lowered.startswith("<ul"):
        return _list(markup, ordered=False)
    if lowered.startswith("<ol"):
        return _list(markup, ordered=True)
    if lowered.startswith("<blockquote"):
        body = _inline(markup)
        return f"> {body}" if body else ""
    if lowered.startswith("<hr"):
        return "---"
    if lowered.startswith("<img"):
        return _picture(markup)
    if lowered.startswith("<figure"):
        return _picture(markup)
    level = int(lowered[2])
    body = _inline(markup)
    # `##` at minimum: a heading inside a section body is always a sub-heading.
    return f"{'#' * max(level, 2)} {body}" if body else ""


#: A footnote's leading mark (`*`, `**`, `1.`); stripped, the exporters number notes.
_NOTE_MARK = re.compile(r"^\s*(\*{1,4}|\d{1,3}[).]?)\s+")


def _note(markup: str, number: int) -> str:
    """A footnote body as a GFM footnote line `[^n]: …`, numbered by order of appearance."""
    text = _NOTE_MARK.sub("", _inline(markup))
    return f"[^{number}]: {text}" if text else ""


#: Structured-block openers, told apart from a plain `<div>`, `<ol>`, `<section>` or `<figure>`.
_KPI_OPEN = re.compile(r"<div\b[^>]*\bclass=\"[^\"]*\bkpi\b", re.I)
_STEPS_OPEN = re.compile(r"<ol\b[^>]*\bclass=\"[^\"]*\bsteps\b", re.I)
_STRONG = re.compile(r"<strong\b[^>]*>(.*?)</strong\s*>", re.S | re.I)
_CARDS_OPEN = re.compile(r"<section\b[^>]*\bclass=\"[^\"]*\bcards\b", re.I)
_CALLOUT_OPEN = re.compile(r"<section\b[^>]*\bclass=\"[^\"]*\bcallout\b", re.I)
_CARD = re.compile(r"<div\b[^>]*>(.*?)</div\s*>", re.S | re.I)
_CARD_TITLE = re.compile(r"<h[34]\b[^>]*>(.*?)</h[34]\s*>", re.S | re.I)
_LI = re.compile(r"<li\b[^>]*>(.*?)</li\s*>", re.S | re.I)
_P = re.compile(r"<p\b[^>]*>(.*?)</p\s*>", re.S | re.I)
_DIAGRAM_OPEN = re.compile(r"<figure\b[^>]*\bclass=\"[^\"]*\bdiagram\b", re.I)
_CHART_OPEN = re.compile(r"<figure\b[^>]*\bclass=\"[^\"]*\bchart\b", re.I)
_DIAGRAM_SOURCE = re.compile(r"\bdata-source=(\"[^\"]*\"|'[^']*')", re.I)


def _cards_fence(markup: str) -> str:
    """A card grid as a `cards` fence: `##` per card, `- ` per line."""
    out: list[str] = []
    body = markup[markup.index(">") + 1 :]
    for card in _CARD.finditer(body):
        inner = card.group(1)
        found = _CARD_TITLE.search(inner)
        title = _inline(found.group(1)) if found else ""
        if not title:
            continue
        out.append(f"## {title}")
        seen = _CARD_TITLE.sub("", inner)
        lines = [_inline(one.group(1)) for one in _LI.finditer(seen)]
        # A card typed as paragraphs rather than a list.
        lines = lines or [_inline(one.group(1)) for one in _P.finditer(seen)]
        out.extend(f"- {line}" for line in lines if line)
    return "```cards\n" + "\n".join(out) + "\n```" if out else ""


def _callout_fence(markup: str) -> str:
    """A callout as a `callout` fence: title first, then its paragraphs."""
    body = markup[markup.index(">") + 1 :]
    found = _CARD_TITLE.search(body)
    title = _inline(found.group(1)) if found else ""
    lines = [_inline(one.group(1)) for one in _P.finditer(_CARD_TITLE.sub("", body))]
    kept = [line for line in [title, *lines] if line]
    return "```callout\n" + "\n".join(kept) + "\n```" if kept else ""


def _diagram_fence(markup: str) -> str:
    """A diagram as a `mermaid` fence from its `data-source`; without one it is a plain picture."""
    found = _DIAGRAM_SOURCE.search(markup)
    if not found:
        return _picture(markup)
    source = html.unescape(found.group(1)[1:-1]).strip()
    return "```mermaid\n" + source + "\n```" if source else _picture(markup)


_SPAN = re.compile(r"<span\b[^>]*>(.*?)</span\s*>", re.S | re.I)


def _pairs_fence(lang: str, markup: str, row_pattern: str) -> str:
    """A KPI strip or steps procedure as a `name | detail` fence; `|` in text becomes `／`."""
    rows: list[str] = []
    # Skip the wrapper tag, which the row pattern would otherwise match first.
    body = markup[markup.index(">") + 1 :]
    for row in re.finditer(row_pattern, body, re.S | re.I):
        inner = row.group(1)
        left = _STRONG.search(inner)
        right = _SPAN.search(inner)
        name = _inline(left.group(1)) if left else _inline(inner)
        detail = _inline(right.group(1)) if right else ""
        name, detail = name.replace("|", "／"), detail.replace("|", "／")
        if name:
            rows.append(f"{name} | {detail}" if detail else name)
    if not rows:
        return ""
    return "```" + lang + "\n" + "\n".join(rows) + "\n```"


#: A picture and, when it has one, the caption under it.
_IMG = re.compile(r"<img\b[^>]*?src=(\"[^\"]*\"|'[^']*'|[^\s>]+)[^>]*>", re.I)
_CAPTION = re.compile(r"<figcaption\b[^>]*>(.*?)</figcaption\s*>", re.S | re.I)


def _picture(markup: str) -> str:
    """A figure as a Markdown image, caption as alt text; caption alone without an `<img>`."""
    found = _IMG.search(markup)
    caption = _CAPTION.search(markup)
    label = _inline(caption.group(1)) if caption else ""
    if not found:
        return label
    src = found.group(1).strip().strip("\"'")
    return f"![{label}]({src})"


def _balanced(fragment: str, start: int, edges: re.Pattern[str] = _LIST_EDGE) -> int:
    """End offset of the construct opening at `start`; `edges` group 1 is `/` on a close."""
    depth = 0
    for edge in edges.finditer(fragment, start):
        depth += -1 if edge.group(1) else 1
        if depth == 0:
            return edge.end()
    return len(fragment)


def to_markdown(fragment: str) -> str:
    """One section's sanitised HTML as Markdown. Inline `style=` is dropped."""
    if not fragment or "<" not in fragment:
        return (fragment or "").strip()

    fragment = _numbered_marks(fragment)

    parts: list[str] = []
    cursor = 0
    notes = 0
    for match in _CONSTRUCT.finditer(fragment):
        if match.start() < cursor:
            # Inside a construct already consumed whole.
            continue
        parts.extend(_paragraphs(fragment[cursor : match.start()]))
        if match.group(0)[:6].lower().startswith("<small"):
            notes += 1
        stop = match.end()
        if match.group(0).lower() in ("<ul", "<ol"):
            stop = _balanced(fragment, match.start())
            rendered = _list(fragment[match.start() : stop], match.group(0).lower() == "<ol")
        elif _KPI_OPEN.match(match.group(0)):
            stop = _balanced(fragment, match.start(), _DIV_EDGE)
            rendered = _pairs_fence(
                "kpi", fragment[match.start() : stop], r"<div\b[^>]*>(.*?)</div\s*>"
            )
        else:
            rendered = _render(match, notes)
        if rendered:
            parts.append(rendered)
        cursor = stop
    parts.extend(_paragraphs(fragment[cursor:]))
    return "\n\n".join(part for part in parts if part.strip())


#: A footnote mark in the prose: `<sup>*</sup>`, `<sup>**</sup>`.
_SUP = re.compile(r"<sup\b[^>]*>.*?</sup\s*>", re.S | re.I)


def _numbered_marks(fragment: str) -> str:
    """`<sup>*</sup>` → `[^1]`, numbered by order of appearance, independently of the notes."""
    counter = iter(range(1, 1000))
    return _SUP.sub(lambda _m: f"[^{next(counter)}]", fragment)


def _paragraphs(fragment: str) -> list[str]:
    """Whatever sits between two constructs, split on block boundaries."""
    if not fragment.strip():
        return []
    chunks = _BLOCK.split(fragment)
    # `re.split` with a group interleaves the tag names; keep only the text between.
    text_chunks = chunks[::2] if len(chunks) > 1 else chunks
    out = [_inline(chunk) for chunk in text_chunks]
    return [line for line in out if line]


#: A GFM table row. The rule row under the head matches too.
_PIPE_ROW = re.compile(r"^\s*\|.*\|\s*$")


def tidy_tables(text: str) -> str:
    """Removes blank lines between GFM table rows; a blank line after the last row stays."""
    lines = (text or "").split("\n")
    out: list[str] = []
    for index, line in enumerate(lines):
        if line.strip():
            out.append(line)
            continue
        before = next((out[i] for i in range(len(out) - 1, -1, -1) if out[i].strip()), "")
        after = next((lines[i] for i in range(index + 1, len(lines)) if lines[i].strip()), "")
        if _PIPE_ROW.match(before) and _PIPE_ROW.match(after):
            continue
        out.append(line)
    return "\n".join(out)


def as_markdown(section: dict) -> str:
    """One section's body as Markdown, whichever `format` it was stored in."""
    body = str(section.get("content") or "")
    return to_markdown(body) if section.get("format") == "html" else body


def normalise(sections: list[dict]) -> list[dict]:
    """Sections with every body as Markdown; HTML sections also carry `tables` and `_formatting`."""
    out: list[dict] = []
    for section in sections:
        body = str(section.get("content") or "")
        moved = {**section, "content": as_markdown(section), "format": "markdown"}
        if section.get("format") == "html":
            moved["_formatting"] = formatted_blocks(body)
        if section.get("format") == "html" and (found := grids(body)):
            moved["tables"] = found
        out.append(moved)
    return out


__all__ = [
    "Cell",
    "Grid",
    "as_markdown",
    "formatted_blocks",
    "grids",
    "normalise",
    "tidy_tables",
    "to_markdown",
]
