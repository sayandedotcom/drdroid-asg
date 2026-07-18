import type OpenAI from "openai";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web and read the content of the top results. Use this whenever the answer depends on current information, recent events, specific facts, statistics, or anything you are not certain about. Prefer several narrow searches over one broad one.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description: "Use 'advanced' for research questions needing deeper page content.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pdf_report",
      description:
        "Produce a downloadable PDF report. Call this when the user asks for a report, document, or written deliverable. Write the full report body in markdown — headings, paragraphs, lists, and links are all rendered. Call this once, at the end, after you have gathered your research.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Report title." },
          markdown: {
            type: "string",
            description:
              "The complete report in markdown. Should be substantial: sections with ## headings, analysis, and a sources list with links.",
          },
        },
        required: ["title", "markdown"],
      },
    },
  },
];

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export async function webSearch(query: string, depth: "basic" | "advanced" = "advanced") {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured on the server.");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: depth === "advanced" ? 6 : 5,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Search failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    results?: { title: string; url: string; content: string }[];
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    // Keep each result bounded so a wide loop doesn't blow up the context.
    content: (r.content ?? "").slice(0, 1500),
  }));

  return { answer: data.answer, results };
}

/** Formats search output as the tool-result string handed back to the model. */
export function formatSearchResult(query: string, r: Awaited<ReturnType<typeof webSearch>>): string {
  if (!r.results.length) return `No results for "${query}".`;
  const parts = r.results.map((x, i) => `[${i + 1}] ${x.title}\nURL: ${x.url}\n${x.content}`);
  const summary = r.answer ? `Quick answer: ${r.answer}\n\n` : "";
  return `${summary}${parts.join("\n\n")}`;
}

export const SYSTEM_PROMPT = `You are MicroManus, a deep research agent.

You have two tools: web_search (search and read live web pages) and create_pdf_report (produce a downloadable PDF).

How to work:
- Search before answering anything that depends on current information, specific facts, numbers, or recent events. Do not answer those from memory.
- Run several focused searches rather than one broad one. Follow up on what you find: if a search surfaces a cause, a place, or a name you did not know about, search again to go deeper.
- Read the results critically. Cross-check claims that matter across more than one source.
- Cite sources inline as markdown links when you state a specific fact.

When to produce a PDF:
- If the user asks for a report, document, write-up, or deliverable, call create_pdf_report once at the end with the complete report in markdown.
- Do not call it for ordinary conversational answers.
- The report should be substantial and well structured: an opening summary, ## sections, concrete detail from your research, and a Sources section with links.

Style: write clearly and directly. Lead with the answer, then the supporting detail. Use markdown headings and lists where they help the reader. Be specific — name the places, dates, numbers, and organisations you found rather than speaking in generalities.`;
