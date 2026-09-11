"""Authorized reads may supply operands, never replace arithmetic verification."""

import json
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_plain_chat_tools import _routed_turn

from app.services import agent
from app.services.tools import registry
from app.services.tools.arithmetic import CALCULATE
from app.services.tools.base import Tool, ToolContext, ToolResult, openai_snapshot
from app.services.tools.builtin import knowledge_tool
from app.services.tools.ncs_check import CHECK_NCS_ANSWER

READ = "mcp__inventory__stock"
QUESTION = "재고 조회 도구에서 상품 101과 102의 재고 수량을 읽어서 총합을 계산해줘."


def _call(name, arguments):
    return {"id": name, "name": name, "arguments": json.dumps(arguments)}


def _read(calls, *, name=READ, read_only=True, result=None):
    async def run(arguments):
        calls.append(deepcopy(arguments))
        return deepcopy(result) if result is not None else ToolResult(content="stock: 7 and 9")

    return Tool(
        name=name, description="Read the stock counts for product IDs.",
        parameters={"type": "object", "properties": {"ids": {"type": "array"}}},
        run=run, label="stock", source="inventory", read_only=read_only,
    )


async def _run(monkeypatch, plans, tools, *, context=None, **kwargs):
    seen = []

    async def model(_model, messages, offered, *_args, **options):
        seen.append({"tools": [tool.name for tool in offered],
                     "messages": deepcopy(messages), "options": deepcopy(options)})
        assert len(seen) <= len(plans), "unbounded model continuation"
        plan = plans[len(seen) - 1]
        acc = agent._Accumulator()
        if isinstance(plan, str):
            acc.content.append(plan)
            yield "delta", plan
        else:
            acc.calls = dict(enumerate(plan))
        yield "done", acc

    monkeypatch.setattr(agent, "_stream_once", model)
    context = context or ToolContext(user_id="synthetic", session_id="synthetic")
    definitions = openai_snapshot(tools)
    original = deepcopy(definitions)
    defaults = {"preflight_tool": "calculate", "calculation_required": True}
    defaults.update(kwargs)
    events = [event async for event in agent.run_turn(
        "synthetic/model", [{"role": "user", "content": QUESTION}], tools, context,
        tool_definitions=definitions, **defaults,
    )]
    assert definitions == original
    for hop in seen:
        offered = [row["function"]["name"] for row in hop["options"]["tool_definitions"]]
        assert offered == hop["tools"]
    text = "".join(event["text"] for event in events if event["type"] == "delta")
    return context, seen, text, events


@pytest.mark.asyncio
@pytest.mark.parametrize("context", ["agent", "skill"])
async def test_request_keeps_authorized_read_before_calculation(monkeypatch, context):
    reads = []
    captured = await _routed_turn(
        monkeypatch, strict=False, question=QUESTION, agent=context == "agent",
        skill="inventory-reader" if context == "skill" else None, extra_tool=_read(reads),
    )
    assert captured["calculation_required"] is True
    assert captured["calculation_expression"] is None
    assert captured["preflight_tool"] == "calculate"
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101, 102]})],
        [_call("calculate", {"expression": "7+9"})], "16",
    ], captured["tools"])
    assert reads == [{"ids": [101, 102]}]
    assert ctx.tool_calls == {READ: 1, "calculate": 1}
    assert set(seen[0]["tools"]) == {READ, "calculate"}
    assert "force_tool" not in seen[0]["options"]
    assert text == "16"


@pytest.mark.asyncio
async def test_builtin_local_knowledge_can_supply_operands(monkeypatch):
    read = knowledge_tool([("inventory", "# Product stock\nProduct 101: 7\nProduct 102: 9", None)])
    assert "101: 7" not in read.description
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call("search_knowledge", {"query": "Product stock"})],
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE, read], strict_local=True)
    assert ctx.tool_calls == {"search_knowledge": 1, "calculate": 1}
    assert any("101: 7" in (row.get("content") or "") for row in seen[1]["messages"])
    assert text == "16"


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["failed", "empty", "blank"])
async def test_failed_read_cannot_proceed_to_fabricated_calculation(monkeypatch, state):
    reads = []
    result = ToolResult(content=" " if state == "blank" else "unusable", failed=state == "failed",
                        empty=state == "empty", final_text="Unverified final answer 999")
    ctx, seen, text, _ = await _run(
        monkeypatch, [[_call(READ, {"ids": [101, 102]})]],
        [CALCULATE, _read(reads, result=result)],
    )
    assert len(reads) == 1
    assert ctx.tool_calls == {READ: 1}
    assert len(seen) == 1
    assert "확정할 수 없습니다" in text
    assert "999" not in text


@pytest.mark.asyncio
async def test_successful_read_terminal_text_cannot_unlock_answer(monkeypatch):
    reads = []
    ctx, _, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101, 102]})],
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE, _read(reads, result=ToolResult(content="stock: 7 and 9", final_text="999"))])
    assert ctx.tool_calls == {READ: 1, "calculate": 1}
    assert text == "16"


@pytest.mark.asyncio
@pytest.mark.parametrize("other", ["calculate", "write"])
async def test_mixed_dependent_or_write_batch_runs_nothing(monkeypatch, other):
    reads = []
    writes = []
    write = _read(writes, name="write", read_only=False)
    ctx, _, text, _ = await _run(monkeypatch, [[
        _call(READ, {"ids": [101, 102]}), _call(other, {"expression": "7+9"}),
    ]], [CALCULATE, _read(reads), write])
    assert reads == writes == []
    assert ctx.tool_calls == {}
    assert "확정할 수 없습니다" in text


@pytest.mark.asyncio
@pytest.mark.parametrize("name,read_only", [
    (READ, False), (READ, None), (READ, 1), ("execute_code", True),
])
async def test_write_unknown_or_code_cannot_be_promoted_to_prerequisite(
    monkeypatch, name, read_only,
):
    calls = []
    ctx, seen, text, _ = await _run(monkeypatch, [[_call(name, {})]],
                                    [CALCULATE, _read(calls, name=name, read_only=read_only)])
    assert seen[0]["tools"] == ["calculate"]
    assert calls == [] and ctx.tool_calls == {}
    assert "확정할 수 없습니다" in text


@pytest.mark.asyncio
async def test_context_allowlist_denies_read_even_if_caller_list_contains_it(monkeypatch):
    reads = []
    context = ToolContext(user_id="qa", session_id="qa", allowed={"calculate"})
    ctx, seen, _, _ = await _run(monkeypatch, [[_call(READ, {})]],
                                [CALCULATE, _read(reads)], context=context)
    assert seen[0]["tools"] == ["calculate"]
    assert ctx.tool_calls == {} and reads == []


@pytest.mark.asyncio
async def test_literal_uses_exact_preset_without_prerequisite_or_model_equation(monkeypatch):
    reads = []
    ctx, seen, text, _ = await _run(monkeypatch, ["40"], [CALCULATE, _read(reads)],
                                   calculation_expression="17+23")
    assert ctx.tool_calls == {"calculate": 1}
    assert reads == [] and len(seen) == 1
    assert text == "40"


@pytest.mark.asyncio
async def test_ncs_gate_stays_exclusive(monkeypatch):
    reads = []
    ctx, seen, text, _ = await _run(monkeypatch, [[_call(READ, {})]],
                                    [CHECK_NCS_ANSWER, _read(reads)],
                                    preflight_tool="check_ncs_answer")
    assert seen[0]["tools"] == ["check_ncs_answer"]
    assert reads == [] and ctx.tool_calls == {}
    assert "확정할 수 없습니다" in text


@pytest.mark.asyncio
async def test_bounded_repair_still_allows_required_read(monkeypatch):
    reads = []
    ctx, seen, text, _ = await _run(monkeypatch, [
        "I need the stock counts first.", [_call(READ, {})],
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE, _read(reads)])
    assert len(seen) == 4 and len(reads) == 1
    assert set(seen[1]["tools"]) == {"calculate", READ}
    assert "force_tool" not in seen[1]["options"]
    assert ctx.tool_calls == {READ: 1, "calculate": 1}
    assert text == "16"


@pytest.mark.asyncio
async def test_hop_cap_without_calculation_never_releases_closing_prose(monkeypatch):
    reads = []
    monkeypatch.setattr(agent.settings, "max_tool_hops", 1)
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101]})], [_call(READ, {"ids": [102]})],
        "Unverified closing answer 999",
    ], [CALCULATE, _read(reads)])
    assert len(reads) == 1 and ctx.tool_calls == {READ: 1}
    assert len(seen) <= 3
    assert "999" not in text and "확정할 수 없습니다" in text


@pytest.mark.asyncio
async def test_duplicate_read_is_not_executed_twice(monkeypatch):
    reads = []
    monkeypatch.setattr(agent.settings, "max_tool_hops", 3)
    ctx, _, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101, 102]})], [_call(READ, {"ids": [101, 102]})],
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE, _read(reads)])
    assert len(reads) == 1
    assert ctx.tool_calls == {READ: 1, "calculate": 1}
    assert text == "16"


@pytest.mark.asyncio
async def test_provided_number_problem_does_not_automatically_execute_read(monkeypatch):
    reads = []
    ctx, _, text, _ = await _run(monkeypatch, [
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE, _read(reads)])
    assert reads == [] and ctx.tool_calls == {"calculate": 1}
    assert text == "16"


@pytest.mark.asyncio
async def test_mcp_empty_adapter_preserves_no_operand_evidence(monkeypatch):
    calls = []

    async def endpoint(_connector):
        return "https://unused.invalid"

    async def empty_call(*_args):
        calls.append(True)
        return ""

    monkeypatch.setattr(registry.catalog, "effective_endpoint", endpoint)
    monkeypatch.setattr(registry.mcp, "call_tool", empty_call)
    connector = SimpleNamespace(transport=SimpleNamespace(value="http"))
    read = replace(_read([]), run=registry._make_runner(connector, "stock", {}))
    assert (await read.run({})).empty is True
    calls.clear()
    ctx, _, text, _ = await _run(monkeypatch, [[_call(READ, {})]], [CALCULATE, read])
    assert len(calls) == 1 and ctx.tool_calls == {READ: 1}
    assert "확정할 수 없습니다" in text


@pytest.mark.asyncio
async def test_knowledge_no_passages_preserves_no_operand_evidence(monkeypatch):
    read = knowledge_tool([])
    assert (await read.run({"query": "stock"})).empty is True
    ctx, _, text, _ = await _run(monkeypatch, [[_call("search_knowledge", {"query": "stock"})]],
                                [CALCULATE, read], strict_local=True)
    assert ctx.tool_calls == {"search_knowledge": 1}
    assert "확정할 수 없습니다" in text
