"""The research loop, as a LangGraph StateGraph.

    agent ──(tool_calls?)──> tools ──> agent ──> END

An explicit graph rather than a prebuilt react agent, because usage has to be
recorded after every individual model call: one user turn with a five-step loop
must produce five costed usage_events rows.
"""

from __future__ import annotations

from typing import Annotated, Any, Callable, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from tools import SYSTEM_PROMPT, RunContext

MAX_MODEL_CALLS = 10
# One agent->tools->agent cycle is two graph steps, plus the final agent turn.
RECURSION_LIMIT = MAX_MODEL_CALLS * 2 + 1


class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def _usage_from(message: AIMessage) -> tuple[int, int, int]:
    """Pull (input, output, cached) tokens off a model response.

    Providers disagree about where cached tokens live and some omit them
    entirely; missing is treated as zero rather than an error.
    """
    meta = getattr(message, "usage_metadata", None) or {}
    input_tokens = int(meta.get("input_tokens") or 0)
    output_tokens = int(meta.get("output_tokens") or 0)
    cached = int((meta.get("input_token_details") or {}).get("cache_read") or 0)

    if not input_tokens and not output_tokens:
        # Fall back to the raw provider payload.
        raw = (getattr(message, "response_metadata", None) or {}).get("token_usage") or {}
        input_tokens = int(raw.get("prompt_tokens") or 0)
        output_tokens = int(raw.get("completion_tokens") or 0)

    if not cached:
        raw = (getattr(message, "response_metadata", None) or {}).get("token_usage") or {}
        details = raw.get("prompt_tokens_details") or {}
        cached = int(
            details.get("cached_tokens")
            or raw.get("cached_tokens")
            or raw.get("cache_read_input_tokens")
            or 0
        )

    return input_tokens, output_tokens, cached


def build_graph(
    *,
    ctx: RunContext,
    model: Any,
    tools: list,
    on_usage: Callable[[int, int, int], None],
):
    """Compiles the graph. `model` is any chat model; tests pass a fake one."""
    bound = model.bind_tools(tools) if tools else model
    call_count = {"n": 0}

    async def agent(state: State) -> dict:
        call_count["n"] += 1
        await ctx.step(
            "thinking", "Thinking" if call_count["n"] == 1 else "Reviewing what I found"
        )

        response = await bound.ainvoke(state["messages"])
        on_usage(*_usage_from(response))
        return {"messages": [response]}

    async def should_continue(state: State) -> str:
        last = state["messages"][-1]
        if getattr(last, "tool_calls", None) and call_count["n"] < MAX_MODEL_CALLS:
            return "tools"
        return END

    graph = StateGraph(State)
    graph.add_node("agent", agent)
    graph.add_node("tools", ToolNode(tools))
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


def build_model(*, model: str, base_url: str, api_key: str) -> ChatOpenAI:
    """Any OpenAI-compatible endpoint — Anthropic, OpenAI and Moonshot all work."""
    return ChatOpenAI(
        model=model,
        base_url=base_url,
        api_key=api_key,
        max_tokens=8000,
        timeout=180,
        max_retries=2,
    )


def initial_messages(history: list[dict[str, str]], message: str) -> list[BaseMessage]:
    """System prompt first and byte-stable, so prompt caching can hit."""
    messages: list[BaseMessage] = [SystemMessage(content=SYSTEM_PROMPT)]
    for turn in history:
        role = turn.get("role")
        content = turn.get("content") or ""
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))
    messages.append(HumanMessage(content=message))
    return messages


def final_text(state: dict) -> str:
    """The assistant's reply for *this* turn.

    Stops at the current user message: if the loop ran out of steps every
    AIMessage it produced is an empty tool call, and scanning further back would
    return a stale reply from an earlier turn instead of saying what happened.
    """
    for message in reversed(state["messages"]):
        if isinstance(message, HumanMessage):
            break
        if isinstance(message, AIMessage) and isinstance(message.content, str) and message.content.strip():
            return message.content
    return "I reached my step limit before finishing. Ask me to continue and I'll pick up from here."
