"""Agent tools: web search (MCP-first) and PDF report generation."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Callable

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

# Kept byte-stable across turns so it can sit in a cacheable prefix wherever the
# provider supports one. See pricing.py for how cache reads are billed.
SYSTEM_PROMPT = """You are MicroManus, a deep research agent.

You have two tools: web_search (search and read live web pages) and create_pdf_report (produce a downloadable PDF).

How to work:
- Search before answering anything that depends on current information, specific facts, numbers, or recent events. Do not answer those from memory.
- Run several focused searches rather than one broad one. Follow up on what you find: if a search surfaces a cause, a place, or a name you did not know about, search again to go deeper.
- Read the results critically. Cross-check claims that matter across more than one source.
- Every search result carries a number. Cite specific facts inline with that number, like [2], and cite the source you actually read the fact in. Numbers stay valid across all of your searches.

When to produce a PDF:
- If the user asks for a report, document, write-up, or deliverable, call create_pdf_report once at the end with the complete report in markdown.
- Do not call it for ordinary conversational answers.
- The report should be substantial and well structured: an opening summary, ## sections, and concrete detail from your research with [n] citations.
- Do not write a sources list yourself. One is appended automatically from the pages you actually opened.

Style: write clearly and directly. Lead with the answer, then the supporting detail. Use markdown headings and lists where they help the reader. Be specific — name the places, dates, numbers, and organisations you found rather than speaking in generalities."""


class RunContext:
    """Per-request plumbing handed to the tools.

    Steps are pushed onto a queue that the SSE endpoint drains, so the UI shows
    the agent's progress while a multi-minute turn is still running.
    """

    def __init__(self, queue: asyncio.Queue, user_id: str, chat_id: str):
        self.queue = queue
        self.user_id = user_id
        self.chat_id = chat_id
        self.steps: list[dict[str, Any]] = []
        # url -> {"n": citation number, "title": …}, in first-seen order. Numbers
        # are global across every search in the turn, so [4] means the same page
        # in the model's third search as in the report's sources list.
        self.sources: dict[str, dict[str, Any]] = {}

    def register_source(self, url: str, title: str = "") -> int:
        """Assigns a stable citation number to a page the agent actually read."""
        known = self.sources.get(url)
        if known:
            if title and not known["title"]:
                known["title"] = title
            return known["n"]
        self.sources[url] = {"n": len(self.sources) + 1, "title": title}
        return self.sources[url]["n"]

    def sources_markdown(self) -> str:
        """The Sources section, built from what was read rather than recalled."""
        if not self.sources:
            return ""
        # The URL is the visible text, not just the link target: a PDF gets
        # printed and forwarded, and a citation you cannot read is not a citation.
        lines = [
            f"{entry['n']}. {entry['title']} — [{url}]({url})" if entry["title"]
            else f"{entry['n']}. [{url}]({url})"
            for url, entry in sorted(self.sources.items(), key=lambda kv: kv[1]["n"])
        ]
        return "## Sources\n\n" + "\n".join(lines) + "\n"

    async def step(self, kind: str, label: str, detail: str | None = None) -> None:
        record = {"kind": kind, "label": label}
        if detail:
            record["detail"] = detail
        self.steps.append(record)
        await self.queue.put({"t": "step", **record})

    async def emit(self, event: dict[str, Any]) -> None:
        await self.queue.put(event)


# --------------------------------------------------------------------- search


_URL_RE = re.compile(r"https?://[^\s\)\]\}<>\"']+")


def _format_results(
    answer: str | None, results: list[dict[str, Any]], query: str, ctx: RunContext
) -> str:
    """Renders results with their *global* citation numbers."""
    if not results:
        return f'No results for "{query}".'
    parts = []
    for r in results:
        url = r.get("url") or ""
        n = ctx.register_source(url, r.get("title") or "")
        parts.append(f"[{n}] {r.get('title', '')}\nURL: {url}\n{(r.get('content') or '')[:1500]}")
    summary = f"Quick answer: {answer}\n\n" if answer else ""
    return summary + "\n\n".join(parts)


def _number_mcp_results(text: str, ctx: RunContext) -> tuple[str, int]:
    """MCP hands back opaque prose, so pull the URLs out and number them.

    The server's own numbering (if any) is local to one search and would collide
    across searches, so the appended block is stated as authoritative.
    """
    urls = list(dict.fromkeys(_URL_RE.findall(text)))
    if not urls:
        return text, 0
    listing = "\n".join(f"[{ctx.register_source(url)}] {url}" for url in urls)
    return (
        f"{text}\n\nCite these sources using exactly these numbers:\n{listing}",
        len(urls),
    )


async def search_via_rest(
    query: str, depth: str = "advanced"
) -> tuple[list[dict[str, Any]], str | None]:
    """Direct Tavily REST call. Mirrors webSearch() in the old lib/tools.ts."""
    api_key = os.environ.get("TAVILY_API_KEY")
    if not api_key:
        raise RuntimeError("TAVILY_API_KEY is not configured on the server.")

    async with httpx.AsyncClient(timeout=60) as http:
        response = await http.post(
            "https://api.tavily.com/search",
            headers={"authorization": f"Bearer {api_key}"},
            json={
                "query": query,
                "search_depth": depth,
                "max_results": 6 if depth == "advanced" else 5,
                "include_answer": True,
            },
        )
        if response.status_code != 200:
            raise RuntimeError(f"Search failed ({response.status_code}): {response.text[:200]}")
        data = response.json()

    return data.get("results") or [], data.get("answer")


class SearchArgs(BaseModel):
    query: str = Field(description="The search query.")
    depth: str = Field(
        default="advanced",
        description="Use 'advanced' for research questions needing deeper page content.",
    )


def build_search_tool(ctx: RunContext, mcp_tool: Any | None) -> StructuredTool:
    """Search tool that prefers Tavily's MCP server and falls back to REST.

    MCP is the primary path because it is how the tool surface is meant to be
    consumed. The fallback exists so a flaky remote MCP server degrades the run
    invisibly rather than breaking it — the reviewer still gets results, and the
    step label records which transport served them.
    """

    async def run(query: str, depth: str = "advanced") -> str:
        transport = "MCP"
        text: str | None = None
        count = 0

        if mcp_tool is not None:
            try:
                raw = await mcp_tool.ainvoke({"query": query})
                text, count = _number_mcp_results(
                    raw if isinstance(raw, str) else str(raw), ctx
                )
            except Exception:
                text = None  # fall through to REST

        if text is None:
            transport = "REST"
            results, answer = await search_via_rest(query, depth)
            text = _format_results(answer, results, query, ctx)
            count = len(results)

        await ctx.step("read", f"Read {count} source{'' if count == 1 else 's'} via {transport}", query)
        return text

    async def with_step(query: str, depth: str = "advanced") -> str:
        await ctx.step("search", "Searching the web", query)
        return await run(query, depth)

    return StructuredTool.from_function(
        coroutine=with_step,
        name="web_search",
        description=(
            "Search the live web and read the content of the top results. Use this whenever the "
            "answer depends on current information, recent events, specific facts, statistics, or "
            "anything you are not certain about. Prefer several narrow searches over one broad one."
        ),
        args_schema=SearchArgs,
    )


# ------------------------------------------------------------------------ pdf


class ReportArgs(BaseModel):
    title: str = Field(description="Report title.")
    markdown: str = Field(
        description=(
            "The complete report in markdown. Should be substantial: sections with ## headings, "
            "analysis, and a sources list with links."
        )
    )


def build_report_tool(ctx: RunContext, upload: Callable[..., str], save: Callable[..., None]) -> StructuredTool:
    """PDF tool. `upload`/`save` are injected so tests can run without Supabase."""
    from pdf import render_report

    async def run(title: str, markdown: str) -> str:
        await ctx.step("pdf", "Writing PDF report", title)
        # Built from the registry rather than from the model's recollection, so
        # the list can only contain pages that were genuinely fetched.
        sources = ctx.sources_markdown()
        body = f"{markdown.rstrip()}\n\n{sources}" if sources else markdown
        pdf_bytes = await asyncio.to_thread(render_report, title, body)
        url = await asyncio.to_thread(
            upload, user_id=ctx.user_id, chat_id=ctx.chat_id, title=title, pdf=pdf_bytes
        )
        await asyncio.to_thread(
            save, chat_id=ctx.chat_id, user_id=ctx.user_id, title=title, url=url
        )
        await ctx.emit({"t": "artifact", "title": title, "url": url})
        return (
            f'The PDF report "{title}" was created and is now visible to the user as a download. '
            "Do not repeat the report body in your reply — just briefly tell them it's ready and "
            "summarise what it covers in two or three sentences."
        )

    return StructuredTool.from_function(
        coroutine=run,
        name="create_pdf_report",
        description=(
            "Produce a downloadable PDF report. Call this when the user asks for a report, "
            "document, or written deliverable. Write the full report body in markdown — headings, "
            "paragraphs, lists, and links are all rendered. Call this once, at the end, after you "
            "have gathered your research."
        ),
        args_schema=ReportArgs,
    )
