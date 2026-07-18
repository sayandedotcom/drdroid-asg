"""End-to-end exercise of a research turn with a scripted model.

This is the test that had to exist before deployment: it proves the LangGraph
loop, the tool wiring, the per-call usage accounting, the PDF path and the
refund-on-failure path all work — without a live LLM key, which we do not have
yet.
"""

from __future__ import annotations

import asyncio
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
            f"[1] Result for {query}\nURL: https://example.com/a\nSome page content.",
            1,
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
    """Search, then write a PDF, then answer — the flagship demo path."""
    script = [
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

    # The step timeline the UI renders.
    step_kinds = [e["kind"] for e in events if e["t"] == "step"]
    assert step_kinds.count("thinking") == 3
    assert "search" in step_kinds and "read" in step_kinds and "pdf" in step_kinds

    # One usage row per model call, not per turn.
    assert len(recorded["usage"]) == 3
    assert [u["input_tokens"] for u in recorded["usage"]] == [1200, 3000, 4200]
    assert [u["cached_tokens"] for u in recorded["usage"]] == [0, 1000, 2800]

    # Cost must price cached tokens at the cache-read rate:
    #   (3000-1000)*3/1M + 1000*0.3/1M + 900*15/1M
    assert recorded["usage"][1]["cost_usd"] == pytest.approx(
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
    script = [AIMessage(content="Paris is the capital of France.", usage_metadata=usage())]
    events, _ = await run_with(script, monkeypatch)

    assert [e["t"] for e in events if e["t"] != "step"] == ["message", "done"]
    assert not recorded["artifacts"]
    assert len(recorded["usage"]) == 1


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
    script = [
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": f"q{i}"}, "id": f"c{i}"}],
            usage_metadata=usage(),
        )
        for i in range(30)
    ]
    events, _ = await run_with(script, monkeypatch)

    assert len(recorded["usage"]) == 10  # MAX_MODEL_CALLS
    message = next(e for e in events if e["t"] == "message")
    assert "step limit" in message["text"]


async def test_search_falls_back_to_rest_when_mcp_fails(recorded, fake_rest_search, monkeypatch):
    """A flaky MCP server should degrade the run, not break it."""

    class BrokenMcpTool:
        name = "tavily_search"

        async def ainvoke(self, _args):
            raise RuntimeError("mcp transport closed")

    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(script=[
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "solid state batteries"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Here is what I found.", usage_metadata=usage()),
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
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "c1"}],
            usage_metadata=usage(),
        ),
        AIMessage(content="Answer.", usage_metadata=usage()),
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


async def test_done_event_carries_remaining_credits(recorded, fake_rest_search, monkeypatch):
    """The UI counter reads this; without it the balance goes stale."""
    from langchain_core.messages import AIMessage as _AIMessage

    monkeypatch.setattr(main, "build_model", lambda **kw: ScriptedModel(
        script=[_AIMessage(content="ok", usage_metadata=usage())]
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
