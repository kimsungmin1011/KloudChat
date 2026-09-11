"""Real save/read/export routes using only an in-memory synthetic workspace.

The JSON fixtures are the actual PATCH bodies captured by the production-build
Playwright table tests. Authentication is stubbed; persistence and exporters are not.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.db import get_session
from app.core.deps import current_user
from app.models.user import User
from app.models.workspace import Artifact, ArtifactKind, ArtifactVersion
from app.routers import workspace
from app.services import report_export, richtext

FIXTURES = Path(__file__).parent / "fixtures/report-table"
_DDL = (
    """CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, project_id TEXT,
        kind TEXT, title TEXT, data TEXT, storage_key TEXT, version INTEGER,
        created_at DATETIME, updated_at DATETIME
    )""",
    """CREATE TABLE artifact_versions (
        id TEXT PRIMARY KEY, artifact_id TEXT, version INTEGER, data TEXT,
        storage_key TEXT, summary TEXT, created_at DATETIME
    )""",
)
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"


@pytest.fixture
async def stored_table(request):
    data = json.loads((FIXTURES / f"report-table-{request.param}.json").read_text())
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as connection:
        for statement in _DDL:
            await connection.exec_driver_sql(statement)
    user = User(id="table-user", email="table@example.test", password_hash="unused", name="Table")
    original = {"kind": "report", "sources": [], "sections": []}
    async with AsyncSession(engine, expire_on_commit=False) as db:
        artifact = Artifact(user_id=user.id, kind=ArtifactKind.report, title="Table", data=original)
        db.add(artifact)
        await db.commit()
        artifact_id = artifact.id
    app = FastAPI()
    app.include_router(workspace.router)

    async def session():
        async with AsyncSession(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_session] = session
    app.dependency_overrides[current_user] = lambda: user
    try:
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            saved = await client.patch(
                f"/artifacts/{artifact_id}",
                json={
                    "title": data["title"],
                    "data": data,
                    "expectedVersion": 1,
                    "summary": "table edit",
                },
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["version"] == 2
            loaded = await client.get(f"/artifacts/{artifact_id}")
            assert loaded.status_code == 200
            assert loaded.json() == saved.json()
            html = loaded.json()["data"]["sections"][0]["content"]
            assert html.count("<tr>") == 3
            for text in ("Item", "Value", "Owner", "Alpha", "10", "A", "Beta", "20", "B"):
                assert f"<p>{text}</p>" in html
            expected_span = {"merged": 2, "full-width-merged": 3}.get(request.param)
            if expected_span:
                assert f'colspan="{expected_span}" rowspan="2"' in html
            # A fresh ORM session checks the committed previous version, not an in-memory object.
            async with AsyncSession(engine) as db:
                history = (await db.exec(select(ArtifactVersion))).all()
                assert len(history) == 1
                assert history[0].version == 1
                assert history[0].data == original
            yield client, artifact_id, expected_span
    finally:
        await engine.dispose()


@pytest.mark.parametrize("stored_table", ["merged", "split", "full-width-merged"], indirect=True)
@pytest.mark.parametrize("format", ["docx", "hwpx", "pdf"])
async def test_saved_browser_table_keeps_cells_and_spans_in_exports(
    stored_table, format, monkeypatch
):
    client, artifact_id, colspan = stored_table
    pdf_tables = []
    real_pdf_table = report_export._pdf_table

    def observe_pdf_table(*args, **kwargs):
        table = real_pdf_table(*args, **kwargs)
        pdf_tables.append(table)
        return table

    monkeypatch.setattr(report_export, "_pdf_table", observe_pdf_table)
    response = await client.get(f"/artifacts/{artifact_id}/export?format={format}")
    assert response.status_code == 200
    if format == "docx":
        with ZipFile(BytesIO(response.content)) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
        table = document.find(f".//{W}tbl")
        assert table is not None
        assert len(table.findall(f"{W}tr")) == 3
        if colspan:
            cell = table.findall(f"{W}tr")[1].find(f"{W}tc")
            assert cell.find(f"{W}tcPr/{W}gridSpan").get(f"{W}val") == str(colspan)
            assert cell.find(f"{W}tcPr/{W}vMerge").get(f"{W}val") == "restart"
            assert table.findall(f"{W}tr")[2].find(f"{W}tc/{W}tcPr/{W}vMerge") is not None
        else:
            assert table.findall(f".//{W}gridSpan") == []
            assert table.findall(f".//{W}vMerge") == []
        text = "\n".join(node.text or "" for node in table.iter(f"{W}t"))
    elif format == "hwpx":
        with ZipFile(BytesIO(response.content)) as archive:
            document = ET.fromstring(archive.read("Contents/section0.xml"))
        table = document.find(f".//{HP}tbl")
        assert table is not None
        assert table.get("rowCnt") == "3"
        assert table.get("colCnt") == "3"
        spans = [node.attrib for node in table.iter(f"{HP}cellSpan")]
        assert {"colSpan": str(colspan or 1), "rowSpan": "2" if colspan else "1"} in spans
        if not colspan:
            assert len(spans) == 9
            assert all(span == {"colSpan": "1", "rowSpan": "1"} for span in spans)
        text = "\n".join(node.text or "" for node in table.iter(f"{HP}t"))
    else:
        assert response.content.startswith(b"%PDF-")
        reader = PdfReader(BytesIO(response.content))
        text = "\n".join(page.extract_text() for page in reader.pages)
        assert len(pdf_tables) == 1
        assert pdf_tables[0]._nrows == 3
        assert pdf_tables[0]._ncols == 3
        expected = [("SPAN", (0, 1), (colspan - 1, 2))] if colspan else []
        assert pdf_tables[0]._spanCmds == expected
        # Inspect actual PDF drawing operators, not just the source table model.
        lines = []
        start = None
        for page in reader.pages:
            for operands, operator in page.get_contents().operations:
                if operator == b"m":
                    start = tuple(float(value) for value in operands)
                elif operator == b"l" and start is not None:
                    lines.append((*start, *(float(value) for value in operands)))
                    start = tuple(float(value) for value in operands)
                elif operator in (b"S", b"n"):
                    start = None

        def drawn(x1, y1, x2, y2):
            return any(line == pytest.approx((x1, y1, x2, y2), abs=0.001) for line in lines)

        table = pdf_tables[0]
        columns, rows = table._colpositions, table._rowpositions
        assert drawn(0, rows[1], columns[3], rows[1])
        if colspan == 3:
            assert not any(abs(y1 - rows[2]) < 0.001 and y1 == y2 for _, y1, _, y2 in lines)
        else:
            assert drawn(columns[colspan or 0], rows[2], columns[3], rows[2])
        if colspan:
            assert drawn(columns[1], rows[1], columns[1], rows[0])
            assert not drawn(columns[1], rows[3], columns[1], rows[0])
    for expected in ("Item", "Value", "Owner", "Alpha", "10", "A", "Beta", "20", "B"):
        assert expected in text.splitlines()


@pytest.mark.parametrize(
    "markup, expected_rows",
    [
        ("<tr><td></td><td></td></tr><tr><td>A</td><td>B</td></tr>", 2),
        ("<tr><td>A</td><td>B</td></tr><tr><td></td><td></td></tr>", 2),
        (
            "<tr><td>A</td><td>B</td></tr><tr><td></td><td></td></tr><tr><td>C</td><td>D</td></tr>",
            3,
        ),
        ("<tr><td rowspan='2' colspan='2'>A</td></tr><tr></tr><tr><td>B</td><td>C</td></tr>", 3),
        ("<tr><td rowspan='3'>A</td><td>B</td></tr><tr><td></td></tr><tr><td>C</td></tr>", 3),
    ],
)
@pytest.mark.parametrize("format", ["docx", "hwpx", "pdf"])
def test_structural_empty_rows_match_the_original_html_grid(
    markup, expected_rows, format, monkeypatch
):
    sections = richtext.normalise([{"format": "html", "content": f"<table>{markup}</table>"}])
    section = sections[0]
    original = section["tables"][0]
    assert len(original.rows) == expected_rows
    tables = [
        payload
        for kind, payload, *_ in report_export._markdown_to_lines(
            section["content"], section["tables"]
        )
        if kind == "table"
    ]
    assert tables == [original]
    assert report_export._export_grid(tables[0]).rows == original.rows
    if format == "docx":
        with ZipFile(BytesIO(report_export.to_docx("Rows", sections))) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
        table = document.find(f".//{W}tbl")
        assert len(table.findall(f"{W}tr")) == expected_rows
    elif format == "hwpx":
        with ZipFile(BytesIO(report_export.to_hwpx("Rows", sections))) as archive:
            document = ET.fromstring(archive.read("Contents/section0.xml"))
        table = document.find(f".//{HP}tbl")
        assert int(table.get("rowCnt")) == expected_rows
    else:
        drawn = []
        real_pdf_table = report_export._pdf_table

        def observe(*args, **kwargs):
            table = real_pdf_table(*args, **kwargs)
            drawn.append(table)
            return table

        monkeypatch.setattr(report_export, "_pdf_table", observe)
        body = report_export.to_pdf("Rows", sections)
        assert PdfReader(BytesIO(body)).pages
        assert len(drawn) == 1
        assert drawn[0]._nrows == expected_rows


def test_plain_markdown_keeps_its_existing_empty_row_cleanup():
    source = "| A | B |\n|---|---|\n| C | D |\n|  |  |\n| E | F |"
    tables = [
        payload for kind, payload, *_ in report_export._markdown_to_lines(source) if kind == "table"
    ]
    assert [table.flat() for table in tables] == [[["A", "B"]], [["C", "D"], ["E", "F"]]]
    assert report_export._export_grid([["A", "B"], ["", ""], ["C", "D"]]).flat() == [
        ["A", "B"],
        ["C", "D"],
    ]


@pytest.mark.parametrize("position", ["before", "after"])
@pytest.mark.parametrize("separator", ["|  |  |", "| : | : |", "|  |  |\n|---|---|"])
def test_unrelated_html_grid_does_not_change_markdown_table_boundaries(position, separator):
    markup = "<table><tr><td>Unrelated</td><td>Grid</td></tr></table>"
    source = f"| A | B |\n|---|---|\n| C | D |\n{separator}\n| E | F |"
    paragraphs = "".join(f"<p>{line}</p>" for line in source.splitlines())
    pieces = [markup, "<p>Separate.</p>", paragraphs]
    if position == "after":
        pieces.reverse()
    section = richtext.normalise([{"format": "html", "content": "".join(pieces)}])[0]
    actual = report_export._markdown_to_lines(section["content"], section["tables"])
    expected = report_export._markdown_to_lines(section["content"])
    assert actual == expected


@pytest.mark.parametrize("separator", ["|  |  |", "| : | : |", "|  |  |\n|---|---|"])
def test_unmatched_grid_prefix_does_not_change_markdown_table_boundaries(separator):
    source = f"| A | B |\n|---|---|\n| C | D |\n{separator}\n| E | F |"
    grid = richtext.Grid(rows=[[richtext.Cell("A"), richtext.Cell("B")]])
    assert report_export._markdown_to_lines(source, [grid]) == report_export._markdown_to_lines(
        source
    )


@pytest.mark.parametrize("format", ["docx", "hwpx", "pdf"])
def test_mixed_html_and_markdown_exports_keep_the_original_plain_table_boundaries(format):
    markup = (
        "<table><tr><td>Unrelated</td><td>Grid</td></tr></table><p>Separate.</p>"
        "<p>| A | B |</p><p>|---|---|</p><p>| C | D |</p><p>|  |  |</p><p>| E | F |</p>"
    )
    section = richtext.normalise([{"format": "html", "content": markup}])[0]
    plain = {key: value for key, value in section.items() if key != "tables"}
    export = getattr(report_export, f"to_{format}")
    actual, expected = export("Mixed tables", [section]), export("Mixed tables", [plain])
    if format == "pdf":
        actual_pages = PdfReader(BytesIO(actual)).pages
        expected_pages = PdfReader(BytesIO(expected)).pages
        assert [page.get_contents().get_data() for page in actual_pages] == [
            page.get_contents().get_data() for page in expected_pages
        ]
    else:
        member = "word/document.xml" if format == "docx" else "Contents/section0.xml"
        with ZipFile(BytesIO(actual)) as actual_zip, ZipFile(BytesIO(expected)) as expected_zip:
            assert actual_zip.read(member) == expected_zip.read(member)


@pytest.mark.parametrize("position", ["before", "after"])
@pytest.mark.parametrize("separated", [False, True])
def test_only_the_matched_table_keeps_structural_empty_rows(position, separated):
    markup = "<table><tr><td rowspan='2' colspan='2'>Merged</td></tr><tr></tr></table>"
    source = "| A | B |\n|---|---|\n| C | D |\n|  |  |\n| E | F |"
    paragraphs = "".join(f"<p>{line}</p>" for line in source.splitlines())
    pieces = [markup, "<p>Separate.</p>" if separated else "", paragraphs]
    if position == "after":
        pieces.reverse()
    section = richtext.normalise([{"format": "html", "content": "".join(pieces)}])[0]
    tables = [
        payload
        for kind, payload, *_ in report_export._markdown_to_lines(
            section["content"], section["tables"]
        )
        if kind == "table"
    ]
    expected = [
        payload for kind, payload, *_ in report_export._markdown_to_lines(source) if kind == "table"
    ]
    expected.insert(0 if position == "before" else len(expected), section["tables"][0])
    assert tables == expected


def test_adjacent_structural_grids_keep_their_own_empty_rows():
    markup = (
        "<table><tr><td rowspan='2' colspan='2'>First</td></tr><tr></tr></table>"
        "<table><tr><td>Second</td><td>Table</td></tr><tr><td></td><td></td></tr></table>"
    )
    section = richtext.normalise([{"format": "html", "content": markup}])[0]
    tables = [
        payload
        for kind, payload, *_ in report_export._markdown_to_lines(
            section["content"], section["tables"]
        )
        if kind == "table"
    ]
    assert tables == section["tables"]


def test_an_entirely_empty_html_table_still_emits_no_export_table():
    sections = richtext.normalise(
        [{"format": "html", "content": "<table><tr><td></td></tr></table>"}]
    )
    assert sections[0]["content"] == ""
    assert report_export._export_grid(sections[0]["tables"][0]).rows == []
