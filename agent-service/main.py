"""MicroManus agent service.

FastAPI + LangGraph. Sits behind the Next.js app, which authenticates the user,
spends the credit and decrypts their model key before calling POST /run. This
service is never exposed to the browser, so a shared secret is sufficient auth
and there is no CORS surface.

Streams the same SSE event shape the frontend already parses:
    {"t": "step"|"artifact"|"message"|"done"|"error", ...}
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import db
from graph import RECURSION_LIMIT, build_graph, build_model, final_text, initial_messages
from pricing import cost_of
from tools import RunContext, build_report_tool, build_search_tool

DONE = object()  # queue sentinel


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to Tavily's MCP server once, not per request.

    A failure here is not fatal: the search tool falls back to Tavily's REST
    API, so the agent still works and the run is only labelled differently.
    """
    app.state.mcp_search = None
    api_key = os.environ.get("TAVILY_API_KEY")

    if api_key:
        try:
            from langchain_mcp_adapters.client import MultiServerMCPClient

            client = MultiServerMCPClient(
                {
                    "tavily": {
                        "url": f"https://mcp.tavily.com/mcp/?tavilyApiKey={api_key}",
                        "transport": "streamable_http",
                    }
                }
            )
            mcp_tools = await asyncio.wait_for(client.get_tools(), timeout=20)
            app.state.mcp_search = next(
                (t for t in mcp_tools if "search" in t.name.lower()), None
            )
            print(f"[mcp] connected, {len(mcp_tools)} tools, search={bool(app.state.mcp_search)}")
        except Exception as exc:  # noqa: BLE001 — degrade, never fail startup
            print(f"[mcp] unavailable, falling back to REST search: {exc}")

    yield


app = FastAPI(title="MicroManus agent service", lifespan=lifespan)


def require_secret(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("AGENT_SERVICE_SECRET")
    if not expected:
        raise HTTPException(500, "AGENT_SERVICE_SECRET is not configured.")
    if authorization != f"Bearer {expected}":
        raise HTTPException(401, "Bad service credentials.")


class Turn(BaseModel):
    role: str
    content: str


class RunRequest(BaseModel):
    user_id: str
    chat_id: str
    model: str
    base_url: str
    api_key: str
    message: str
    history: list[Turn] = Field(default_factory=list)
    # Balance after Next.js spent the credit for this turn; echoed back on
    # success so the UI counter stays accurate without another round trip.
    credits_remaining: int | None = None


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "mcp_search": bool(getattr(app.state, "mcp_search", None))}


async def _run_episode(req: RunRequest, ctx: RunContext, queue: asyncio.Queue) -> None:
    """Drives the graph and pushes terminal events onto the queue."""
    try:
        search = build_search_tool(ctx, getattr(app.state, "mcp_search", None))
        report = build_report_tool(ctx, db.upload_report, db.save_artifact)

        def on_usage(input_tokens: int, output_tokens: int, cached: int) -> None:
            db.record_usage(
                chat_id=req.chat_id,
                user_id=req.user_id,
                model=req.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_tokens=cached,
                cost_usd=cost_of(req.model, input_tokens, output_tokens, cached),
            )

        graph = build_graph(
            ctx=ctx,
            model=build_model(model=req.model, base_url=req.base_url, api_key=req.api_key),
            tools=[search, report],
            on_usage=on_usage,
        )

        history = [{"role": t.role, "content": t.content} for t in req.history]
        state = await graph.ainvoke(
            {
                "messages": initial_messages(history, req.message),
                "used_tools": False,
                "critique_done": False,
            },
            config={"recursion_limit": RECURSION_LIMIT},
        )

        text = final_text(state)
        await queue.put({"t": "message", "text": text})

        await asyncio.to_thread(
            db.save_assistant_message,
            chat_id=req.chat_id,
            user_id=req.user_id,
            content=text,
            steps=ctx.steps,
        )
        done: dict[str, Any] = {"t": "done"}
        if req.credits_remaining is not None:
            done["credits"] = req.credits_remaining
        await queue.put(done)

    except Exception as exc:  # noqa: BLE001
        # The turn produced nothing usable, so give back the credit Next.js
        # spent before calling us rather than charging for a failed run.
        credits = None
        try:
            credits = await asyncio.to_thread(db.refund_credit, req.user_id)
        except Exception as refund_error:  # noqa: BLE001
            print(f"[refund] failed for {req.user_id}: {refund_error}")

        event: dict[str, Any] = {"t": "error", "message": str(exc)}
        if credits is not None:
            event["credits"] = credits
        await queue.put(event)
    finally:
        await queue.put(DONE)


@app.post("/run", dependencies=[Depends(require_secret)])
async def run(req: RunRequest) -> StreamingResponse:
    queue: asyncio.Queue = asyncio.Queue()
    ctx = RunContext(queue, req.user_id, req.chat_id)

    async def stream():
        task = asyncio.create_task(_run_episode(req, ctx, queue))
        try:
            while True:
                event = await queue.get()
                if event is DONE:
                    break
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
    )
