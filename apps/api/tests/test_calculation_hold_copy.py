"""Ordinary calculation holds describe verification, without weakening its gate."""

import pytest
from test_calculation_read_prerequisites import READ, _call, _read, _run

from app.services import agent
from app.services.tools.arithmetic import CALCULATE
from app.services.tools.base import ToolContext
from app.services.tools.ncs_check import CHECK_NCS_ANSWER

CALCULATION_HOLD = (
    "계산기의 검산을 완료하지 못해 수치 답변을 확정할 수 없습니다. "
    "필요한 값과 계산 조건을 확인해 주세요."
)
NCS_HOLD = (
    "문항 검산 절차를 완료하지 못해 정답이나 채점을 확정할 수 없습니다. "
    "다시 시도해 주세요."
)


@pytest.mark.asyncio
async def test_missing_calculator_keeps_one_repair_and_uses_calculation_hold(monkeypatch):
    draft = "Unverified quantity 999"
    ctx, seen, text, events = await _run(monkeypatch, [draft, draft], [CALCULATE])
    assert text == CALCULATION_HOLD
    assert len(seen) == 2 and ctx.tool_calls == {}
    assert not any(draft in str(message) for message in seen[1]["messages"])
    assert [event for event in events if event["type"] == "step"][-1]["status"] == "error"
    assert not any(event["type"] == "tool_result_answer" for event in events)


@pytest.mark.asyncio
async def test_read_results_do_not_certify_missing_operand_or_release_model_prose(monkeypatch):
    reads = []
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101]})], [_call(READ, {"ids": [103]})],
        "Product 103 is missing, trust my assertion.", "Unverified quantity 999",
    ], [CALCULATE, _read(reads)])
    assert len(seen) == 4 and len(reads) == 2 and ctx.tool_calls == {READ: 2}
    assert text == CALCULATION_HOLD
    assert "103" not in text and "999" not in text


@pytest.mark.asyncio
async def test_hop_limit_keeps_closing_answer_held_with_calculation_copy(monkeypatch):
    monkeypatch.setattr(agent.settings, "max_tool_hops", 1)
    reads = []
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call(READ, {"ids": [101]})], [_call(READ, {"ids": [103]})],
        "Unverified closing quantity 999",
    ], [CALCULATE, _read(reads)])
    assert len(seen) == 3 and len(reads) == 1 and ctx.tool_calls == {READ: 1}
    assert text == CALCULATION_HOLD


@pytest.mark.asyncio
@pytest.mark.parametrize("other", ["calculate", "write"])
async def test_invalid_mixed_batch_keeps_zero_dispatch_with_calculation_copy(monkeypatch, other):
    reads, writes = [], []
    ctx, seen, text, _ = await _run(monkeypatch, [[
        _call(READ, {}), _call(other, {"expression": "7+9"}),
    ]], [CALCULATE, _read(reads), _read(writes, name="write", read_only=False)])
    assert len(seen) == 1 and ctx.tool_calls == {} and reads == writes == []
    assert text == CALCULATION_HOLD


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["looped", "runaway"])
async def test_loop_or_runaway_keeps_immediate_hold_without_new_repair(monkeypatch, flag):
    calls = []

    async def stream(*_args, **_kwargs):
        calls.append(True)
        acc = agent._Accumulator()
        setattr(acc, flag, True if flag == "looped" else "x")
        acc.content.append("Unverified quantity 999")
        yield "delta", "Unverified quantity 999"
        yield "done", acc

    monkeypatch.setattr(agent, "_stream_once", stream)
    ctx = ToolContext(user_id="synthetic", session_id="synthetic")
    events = [event async for event in agent.run_turn(
        "synthetic/model", [], [CALCULATE], ctx,
        preflight_tool="calculate", calculation_required=True,
    )]
    assert len(calls) == 1 and ctx.tool_calls == {}
    text = "".join(event["text"] for event in events if event["type"] == "delta")
    assert text == CALCULATION_HOLD


@pytest.mark.asyncio
async def test_ncs_checker_keeps_its_existing_message_and_bound(monkeypatch):
    ctx, seen, text, _ = await _run(
        monkeypatch, ["Unverified grading", "Unverified grading"], [CHECK_NCS_ANSWER],
        preflight_tool="check_ncs_answer",
    )
    assert text == NCS_HOLD and len(seen) == 2 and ctx.tool_calls == {}


@pytest.mark.asyncio
async def test_noncalculation_preflight_copy_remains_unchanged(monkeypatch):
    ctx, seen, text, _ = await _run(
        monkeypatch, ["Unverified response"], [CALCULATE], calculation_required=False,
    )
    assert text == NCS_HOLD and len(seen) == 1 and ctx.tool_calls == {}


@pytest.mark.asyncio
async def test_successful_verification_still_releases_answer(monkeypatch):
    ctx, seen, text, _ = await _run(monkeypatch, [
        [_call("calculate", {"expression": "7+9"})], "16",
    ], [CALCULATE])
    assert text == "16" and len(seen) == 2 and ctx.tool_calls == {"calculate": 1}
