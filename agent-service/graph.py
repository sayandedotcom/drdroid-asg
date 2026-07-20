"""The research loop, as a LangGraph StateGraph.

    plan ──> agent ──(tool_calls?)──> tools ──> agent ──> END

An explicit graph rather than a prebuilt react agent, for two reasons: usage has
to be recorded after every individual model call (one user turn with a five-step
loop must produce five costed usage_events rows), and the loop is not a bare
react cycle — a planning pass runs first.
"""

from __future__ import annotations

from typing import Annotated, Any, Callable, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from tools import SYSTEM_PROMPT, RunContext

MAX_MODEL_CALLS = 12
# One agent->tools->agent cycle is two graph steps; plus the plan pass and the
# final agent turn, with margin.
RECURSION_LIMIT = MAX_MODEL_CALLS * 2 + 6

# Marks messages this service injected rather than the user or the model, so
# final_text() can tell them apart from a real reply.
INTERNAL = {"micromanus_internal": True}

PLAN_INSTRUCTION = """Before you answer, decide whether this needs live research.

If it does, reply with a short numbered research plan — at most four steps, one line each, naming what you will search for and why. Nothing else.
If you can answer it directly without searching, reply with exactly: NO_PLAN"""


class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def _is_internal(message: BaseMessage) -> bool:
    return bool((getattr(message, "additional_kwargs", None) or {}).get("micromanus_internal"))


def _text_of(message: BaseMessage) -> str:
    content = getattr(message, "content", "")
    return content.strip() if isinstance(content, str) else ""


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
    agent_turns = {"n": 0}

    async def track(response: AIMessage) -> None:
        call_count["n"] += 1
        on_usage(*_usage_from(response))

    async def plan(state: State) -> dict:
        """Decide what to research before researching it.

        Unbound (no tools) so this pass can only think, not act. A question that
        needs no research answers NO_PLAN and costs one cheap call.
        """
        response = await model.ainvoke(
            [*state["messages"], HumanMessage(content=PLAN_INSTRUCTION)]
        )
        await track(response)

        text = _text_of(response)
        if not text or "NO_PLAN" in text.upper():
            return {}

        await ctx.step("plan", "Planned the research", text)
        return {
            "messages": [
                AIMessage(content=f"My research plan:\n{text}", additional_kwargs=INTERNAL)
            ]
        }

    async def agent(state: State) -> dict:
        agent_turns["n"] += 1
        await ctx.step(
            "thinking", "Thinking" if agent_turns["n"] == 1 else "Reviewing what I found"
        )

        response = await bound.ainvoke(state["messages"])
        await track(response)
        return {"messages": [response]}

    async def should_continue(state: State) -> str:
        last = state["messages"][-1]
        if getattr(last, "tool_calls", None) and call_count["n"] < MAX_MODEL_CALLS:
            return "tools"
        return END

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("agent", agent)
    graph.add_node("tools", ToolNode(tools))
    graph.set_entry_point("plan")
    graph.add_edge("plan", "agent")
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

    Messages this service injected (the research plan, reviewer feedback) are
    skipped rather than stopped at — the plan is not an answer, and skipping the
    feedback lets a failed revision fall back to the draft it was revising.
    """
    for message in reversed(state["messages"]):
        if _is_internal(message):
            continue
        if isinstance(message, HumanMessage):
            break
        if isinstance(message, AIMessage) and _text_of(message):
            return message.content
    return "I reached my step limit before finishing. Ask me to continue and I'll pick up from here."
