"""End-to-end exercise of a research turn with a scripted model.

This is the test that had to exist before deployment: it proves the LangGraph
loop, the tool wiring, the per-call usage accounting, the PDF path and the
refund-on-failure path all work — without a live LLM key, which we do not have
yet.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import db
import main
import tools as tools_mod
from main import RunRequest, _run_episode
from tools import RunContext


class ScriptedModel(BaseChatModel):
    """Replays a fixed list of AIMessages, one per call."""

    script: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):  # noqa: ANN001 — tools are ignored
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # noqa: ANN001
        message = self.script.pop(0)
        if isinstance(message, Exception):
            raise message
        return ChatResult(generations=[ChatGeneration(message=message)])


def extract_pdf_text(pdf: bytes) -> str:
    """Reads a generated PDF back. Skips where poppler isn't installed."""
    if not shutil.which("pdftotext"):
        pytest.skip("pdftotext (poppler-utils) not available")
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf)
        f.flush()
        return subprocess.run(
            ["pdftotext", f.name, "-"], capture_output=True, text=True, check=True
        ).stdout


def plan_reply(text: str = "NO_PLAN", **kw) -> AIMessage:
    """The graph's first model call is always the planning pass."""
    return AIMessage(content=text, usage_metadata=usage(**kw))


def critique_reply(text: str = "APPROVED", **kw) -> AIMessage:
    """Turns that used tools get one reflection pass before answering."""
    return AIMessage(content=text, usage_metadata=usage(**kw))


def usage(input_tokens=1000, output_tokens=60, cached=0) -> dict[str, Any]:
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "input_token_details": {"cache_read": cached},
    }


@pytest.fixture
def recorded(monkeypatch):
    """Replaces every Supabase call with an in-memory recorder."""
    store: dict[str, list] = {"usage": [], "messages": [], "artifacts": [], "refunds": []}

    monkeypatch.setattr(db, "record_usage", lambda **kw: store["usage"].append(kw))
    monkeypatch.setattr(db, "save_assistant_message", lambda **kw: store["messages"].append(kw))
    monkeypatch.setattr(
        db, "upload_report", lambda **kw: (store["artifacts"].append(kw), "https://cdn.test/r.pdf")[1]
    )
    monkeypatch.setattr(db, "save_artifact", lambda **kw: None)
    monkeypatch.setattr(db, "refund_credit", lambda user_id: (store["refunds"].append(user_id), 4)[1])
    return store


@pytest.fixture
def fake_rest_search(monkeypatch):
    calls: list[str] = []

    async def _search(query: str, depth: str = "advanced"):
        calls.append(query)
        return (
            [
                {
                    "title": f"Result for {query}",
                    "url": f"https://example.com/{len(calls)}",
                    "content": "Some page content.",
                }
            ],
            None,
        )

    monkeypatch.setattr(tools_mod, "search_via_rest", _search)
    return calls


def request_for(message="Report on California wildfires") -> RunRequest:
    return RunRequest(
        user_id="user-1",
        chat_id="chat-1",
        model="claude-sonnet-5",
        base_url="https://api.anthropic.com/v1/",
        api_key="sk-test",
        message=message,
        history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    )


async def drain(queue: asyncio.Queue) -> list[dict]:
    events = []
    while True:
        item = await queue.get()
        if item is main.DONE:
            return events
        events.append(item)


async def run_with(script: list, monkeypatch) -> tuple[list[dict], RunContext]:
    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(script=script))
    monkeypatch.setattr(main.app.state, "mcp_search", None, raising=False)

    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(request_for(), ctx, queue))
    events = await drain(queue)
    await task
    return events, ctx


async def test_full_research_turn(recorded, fake_rest_search, monkeypatch):
    """Plan, search, write a PDF, then answer — the flagship demo path."""
    script = [
        plan_reply("1. Search for causes of the 2025 fires\n2. Search for mitigation policy"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "california wildfire causes"}, "id": "c1"}],
            usage_metadata=usage(1200, 40),
        ),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "create_pdf_report",
                    "args": {
                        "title": "California Wildfires",
                        "markdown": "## Causes\n\n- Drought\n- Fuel load\n\n[Source](https://x.com)",
                    },
                    "id": "c2",
                }
            ],
            usage_metadata=usage(3000, 900, cached=1000),
        ),
        AIMessage(content="Your report is ready. It covers causes and mitigation.", usage_metadata=usage(4200, 120, cached=2800)),
        critique_reply("APPROVED"),
    ]

    events, ctx = await run_with(script, monkeypatch)
    kinds = [e["t"] for e in events]

    assert kinds[-2:] == ["message", "done"]
    assert "artifact" in kinds

    artifact = next(e for e in events if e["t"] == "artifact")
    assert artifact["title"] == "California Wildfires"
    assert artifact["url"] == "https://cdn.test/r.pdf"

    message = next(e for e in events if e["t"] == "message")
    assert message["text"] == "Your report is ready. It covers causes and mitigation."

    # The step timeline the UI renders. The plan is announced before the work.
    step_kinds = [e["kind"] for e in events if e["t"] == "step"]
    assert step_kinds[0] == "plan"
    assert step_kinds[-1] == "critique"
    assert step_kinds.count("thinking") == 3
    assert "search" in step_kinds and "read" in step_kinds and "pdf" in step_kinds

    plan_step = next(e for e in events if e.get("kind") == "plan")
    assert "Search for causes" in plan_step["detail"]

    # One usage row per model call, not per turn — plan and critique included.
    assert len(recorded["usage"]) == 5
    assert [u["input_tokens"] for u in recorded["usage"]] == [1000, 1200, 3000, 4200, 1000]
    assert [u["cached_tokens"] for u in recorded["usage"]] == [0, 0, 1000, 2800, 0]

    # Cost must price cached tokens at the cache-read rate:
    #   (3000-1000)*3/1M + 1000*0.3/1M + 900*15/1M
    assert recorded["usage"][2]["cost_usd"] == pytest.approx(
        (2000 * 3 + 1000 * 0.3 + 900 * 15) / 1_000_000
    )

    # The assistant message is persisted with its steps for later replay.
    assert len(recorded["messages"]) == 1
    assert recorded["messages"][0]["content"].startswith("Your report is ready")
    assert recorded["messages"][0]["steps"] == ctx.steps
    assert not recorded["refunds"]

    # A real PDF was produced and handed to storage.
    pdf_bytes = recorded["artifacts"][0]["pdf"]
    assert pdf_bytes[:5] == b"%PDF-"
    assert len(pdf_bytes) > 2000


async def test_conversational_turn_makes_no_pdf(recorded, fake_rest_search, monkeypatch):
    script = [
        plan_reply("NO_PLAN"),
        AIMessage(content="Paris is the capital of France.", usage_metadata=usage()),
    ]
    events, _ = await run_with(script, monkeypatch)

    assert [e["t"] for e in events if e["t"] not in {"step", "delta"}] == ["message", "done"]
    assert not recorded["artifacts"]
    # Planning call plus the answer; NO_PLAN adds no step to the timeline.
    assert len(recorded["usage"]) == 2
    assert not [e for e in events if e.get("kind") == "plan"]


async def test_failure_refunds_the_credit(recorded, fake_rest_search, monkeypatch):
    """A provider outage must not cost the user a credit."""
    script = [RuntimeError("upstream 529 overloaded")]
    events, _ = await run_with(script, monkeypatch)

    error = next(e for e in events if e["t"] == "error")
    assert "529" in error["message"]
    assert error["credits"] == 4
    assert recorded["refunds"] == ["user-1"]
    assert not recorded["messages"]


async def test_loop_stops_at_the_step_limit(recorded, fake_rest_search, monkeypatch):
    """A model that only ever calls tools must terminate, not run forever."""
    script = [plan_reply("1. Search endlessly")] + [
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": f"q{i}"}, "id": f"c{i}"}],
            usage_metadata=usage(),
        )
        for i in range(30)
    ]
    events, _ = await run_with(script, monkeypatch)

    assert len(recorded["usage"]) == 12  # MAX_MODEL_CALLS, planning included
    message = next(e for e in events if e["t"] == "message")
    assert "step limit" in message["text"]


async def test_search_falls_back_to_rest_when_mcp_fails(recorded, fake_rest_search, monkeypatch):
    """A flaky MCP server should degrade the run, not break it."""

    class BrokenMcpTool:
        name = "tavily_search"

        async def ainvoke(self, _args):
            raise RuntimeError("mcp transport closed")

    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(script=[
        plan_reply("1. Search battery chemistry"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "solid state batteries"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Here is what I found.", usage_metadata=usage()),
        critique_reply(),
    ]))
    monkeypatch.setattr(main.app.state, "mcp_search", BrokenMcpTool(), raising=False)

    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(request_for(), ctx, queue))
    events = await drain(queue)
    await task

    assert fake_rest_search == ["solid state batteries"]
    read_step = next(e for e in events if e.get("kind") == "read")
    assert "via REST" in read_step["label"]
    assert next(e for e in events if e["t"] == "message")["text"] == "Here is what I found."


async def test_search_uses_mcp_when_available(recorded, fake_rest_search, monkeypatch):
    class WorkingMcpTool:
        name = "tavily_search"

        async def ainvoke(self, _args):
            return "[1] MCP result\nURL: https://example.com/mcp\nBody text."

    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(script=[
        plan_reply("1. Search it"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Answer.", usage_metadata=usage()),
        critique_reply(),
    ]))
    monkeypatch.setattr(main.app.state, "mcp_search", WorkingMcpTool(), raising=False)

    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(request_for(), ctx, queue))
    events = await drain(queue)
    await task

    assert fake_rest_search == []  # REST was never touched
    read_step = next(e for e in events if e.get("kind") == "read")
    assert "via MCP" in read_step["label"]


async def test_critique_sends_the_draft_back_for_one_revision(
    recorded, fake_rest_search, monkeypatch
):
    """A review that finds gaps must change the answer the user sees."""
    script = [
        plan_reply("1. Look it up"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Draft answer with a shaky claim.", usage_metadata=usage()),
        critique_reply("- The claim about costs is not in any source you read."),
        AIMessage(content="Revised answer, claim removed.", usage_metadata=usage()),
        critique_reply("APPROVED"),  # must never be consumed — one pass only
    ]
    events, _ = await run_with(script, monkeypatch)

    assert next(e for e in events if e["t"] == "message")["text"] == "Revised answer, claim removed."

    labels = [e["label"] for e in events if e.get("kind") in {"critique", "thinking"}]
    assert "Found gaps to fix" in labels
    assert "Revising after review" in labels

    # plan + tool call + draft + critique + revision. The second critique is
    # never reached, so exactly one reflection pass happened.
    assert len(recorded["usage"]) == 5
    assert recorded["messages"][0]["content"] == "Revised answer, claim removed."


async def test_report_cites_only_pages_that_were_read(recorded, fake_rest_search, monkeypatch):
    """The sources list is built from the registry, not from the model's memory."""
    script = [
        plan_reply("1. Search twice"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "first"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "second"}, "id": "c2"}],
            usage_metadata=usage(),
        ),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "create_pdf_report",
                    "args": {
                        "title": "Findings",
                        # The model invents a source it never opened; it must not
                        # survive into the generated sources list.
                        "markdown": "## Findings\n\nDrought is the driver [1].",
                    },
                    "id": "c3",
                }
            ],
            usage_metadata=usage(),
        ),
        AIMessage(content="Report ready.", usage_metadata=usage()),
        critique_reply(),
    ]
    events, ctx = await run_with(script, monkeypatch)

    # Two searches, two distinct pages, numbered globally rather than per-search.
    assert [e["n"] for e in ctx.sources.values()] == [1, 2]
    assert set(ctx.sources) == {"https://example.com/1", "https://example.com/2"}

    text = extract_pdf_text(recorded["artifacts"][0]["pdf"])
    assert "Sources" in text
    assert "example.com/1" in text and "example.com/2" in text
    assert next(e for e in events if e["t"] == "artifact")["title"] == "Findings"


async def test_search_results_carry_global_citation_numbers(recorded, monkeypatch):
    """Numbers must not restart per search, or [1] would be ambiguous."""
    ctx = RunContext(asyncio.Queue(), "u", "c")
    seen: list[str] = []

    async def _search(query: str, depth: str = "advanced"):
        seen.append(query)
        return (
            [
                {"title": "A", "url": "https://a.test", "content": "a"},
                {"title": "B", "url": "https://b.test", "content": "b"},
            ]
            if len(seen) == 1
            else [
                {"title": "B", "url": "https://b.test", "content": "b"},  # repeat
                {"title": "C", "url": "https://c.test", "content": "c"},
            ],
            None,
        )

    monkeypatch.setattr(tools_mod, "search_via_rest", _search)
    tool = tools_mod.build_search_tool(ctx, None)

    first = await tool.coroutine(query="one")
    second = await tool.coroutine(query="two")

    assert "[1] A" in first and "[2] B" in first
    # B keeps its number; only C is new.
    assert "[2] B" in second and "[3] C" in second
    assert [e["n"] for e in ctx.sources.values()] == [1, 2, 3]


async def test_conversational_turn_is_not_critiqued(recorded, fake_rest_search, monkeypatch):
    """Reflection costs a model call; a turn that did no research skips it."""
    script = [
        plan_reply("NO_PLAN"),
        AIMessage(content="Paris.", usage_metadata=usage()),
    ]
    events, _ = await run_with(script, monkeypatch)

    assert not [e for e in events if e.get("kind") == "critique"]
    assert len(recorded["usage"]) == 2


async def test_step_limit_still_reports_rather_than_returning_the_plan(
    recorded, fake_rest_search, monkeypatch
):
    """The injected plan is not an answer — exhausting the budget must say so."""
    script = [plan_reply("1. Search forever")] + [
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": f"q{i}"}, "id": f"c{i}"}],
            usage_metadata=usage(),
        )
        for i in range(30)
    ]
    events, _ = await run_with(script, monkeypatch)

    text = next(e for e in events if e["t"] == "message")["text"]
    assert "step limit" in text
    assert "research plan" not in text


async def test_answer_streams_before_the_final_message(recorded, fake_rest_search, monkeypatch):
    """Deltas must arrive first and reconstruct exactly what `message` sends."""
    script = [
        plan_reply("NO_PLAN"),
        AIMessage(content="Paris is the capital of France.", usage_metadata=usage()),
    ]
    events, _ = await run_with(script, monkeypatch)

    kinds = [e["t"] for e in events if e["t"] in {"delta", "message"}]
    assert kinds[0] == "delta" and kinds[-1] == "message"

    streamed = "".join(e["text"] for e in events if e["t"] == "delta")
    assert streamed == next(e for e in events if e["t"] == "message")["text"]

    # Usage survives accumulation across chunks; billing must not go to zero.
    assert recorded["usage"][-1]["input_tokens"] == 1000


async def test_revision_restarts_the_stream(recorded, fake_rest_search, monkeypatch):
    """Otherwise the revised answer would append to the draft in the UI."""
    script = [
        plan_reply("1. Look it up"),
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Draft.", usage_metadata=usage()),
        critique_reply("- Fix the unsupported claim."),
        AIMessage(content="Revised.", usage_metadata=usage()),
    ]
    events, _ = await run_with(script, monkeypatch)

    deltas = [e for e in events if e["t"] == "delta"]
    # Two separate answers streamed, each opening with a restart marker.
    assert [d.get("restart") for d in deltas] == [True, True]
    assert [d["text"] for d in deltas] == ["Draft.", "Revised."]
    assert next(e for e in events if e["t"] == "message")["text"] == "Revised."


async def test_streaming_failure_falls_back_to_a_plain_call(
    recorded, fake_rest_search, monkeypatch
):
    """A provider that rejects stream_options must still produce an answer."""

    class NoStreamModel(ScriptedModel):
        def bind_tools(self, tools, **kwargs):
            return self

        async def astream(self, *a, **kw):
            raise RuntimeError("stream_options is not supported")
            yield  # pragma: no cover — makes this an async generator

    monkeypatch.setattr(
        main,
        "build_model",
        lambda **kw: NoStreamModel(script=[
            plan_reply("NO_PLAN"),
            AIMessage(content="Answered without streaming.", usage_metadata=usage()),
        ]),
    )
    monkeypatch.setattr(main.app.state, "mcp_search", None, raising=False)

    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(request_for(), ctx, queue))
    events = await drain(queue)
    await task

    assert not [e for e in events if e["t"] == "delta"]
    assert next(e for e in events if e["t"] == "message")["text"] == "Answered without streaming."
    assert recorded["usage"][-1]["input_tokens"] == 1000


async def test_done_event_carries_remaining_credits(recorded, fake_rest_search, monkeypatch):
    """The UI counter reads this; without it the balance goes stale."""
    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(
        script=[plan_reply(), AIMessage(content="ok", usage_metadata=usage())]
    ))
    monkeypatch.setattr(main.app.state, "mcp_search", None, raising=False)

    req = request_for()
    req.credits_remaining = 3
    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(req, ctx, queue))
    events = await drain(queue)
    await task

    assert next(e for e in events if e["t"] == "done")["credits"] == 3


async def test_usage_rows_are_written_before_the_done_event(recorded, monkeypatch):
    """Usage writes are handed to a thread so they don't stall the token stream.

    That makes them racy: the client refreshes the cost page off `done`, so every
    row has to have landed by the time that event goes out.
    """
    import time

    def slow_record(**kw):
        time.sleep(0.05)  # a real blocking write, of the kind that must not block the loop
        recorded["usage"].append(kw)

    monkeypatch.setattr(db, "record_usage", slow_record)
    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(
        script=[plan_reply(), AIMessage(content="ok", usage_metadata=usage())]
    ))
    monkeypatch.setattr(main.app.state, "mcp_search", None, raising=False)

    rows_at_done: list[int] = []

    class WatchedQueue(asyncio.Queue):
        async def put(self, item):
            if isinstance(item, dict) and item.get("t") == "done":
                rows_at_done.append(len(recorded["usage"]))
            await super().put(item)

    queue = WatchedQueue()
    ctx = RunContext(queue, "user-1", "chat-1")
    task = asyncio.create_task(_run_episode(request_for(), ctx, queue))
    await drain(queue)
    await task

    assert recorded["usage"], "no usage rows were recorded"
    assert rows_at_done == [len(recorded["usage"])], "done fired before the usage writes settled"
