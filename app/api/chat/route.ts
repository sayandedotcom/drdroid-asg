import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseServer, supabaseAdmin, currentUser } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { costOf } from "@/lib/models";
import { TOOLS, SYSTEM_PROMPT, webSearch, formatSearchResult } from "@/lib/tools";
import { renderReportPdf } from "@/lib/pdf";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ITERATIONS = 10;

/**
 * Cached-token counts live in different places depending on the provider, and
 * some omit them entirely. Missing means zero, never an error.
 */
function cachedTokensFrom(usage: unknown): number {
  const u = usage as Record<string, unknown> | undefined;
  if (!u) return 0;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  return (
    Number(details?.cached_tokens ?? 0) ||
    Number(u.cached_tokens ?? 0) ||
    Number(u.cache_read_input_tokens ?? 0) ||
    0
  );
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { chatId, message } = (await req.json()) as { chatId?: string; message?: string };
  if (!chatId || !message?.trim()) {
    return NextResponse.json({ error: "chatId and message are required." }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const sb = await supabaseServer();

  // The chat must belong to the caller. RLS enforces this too, but failing
  // here gives a clearer error.
  const { data: chat } = await sb.from("chats").select("id, model, title").eq("id", chatId).single();
  if (!chat) return NextResponse.json({ error: "Chat not found." }, { status: 404 });

  const { data: config } = await admin
    .from("llm_configs")
    .select("base_url, encrypted_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!config) {
    return NextResponse.json({ error: "Add your API key in Settings first." }, { status: 400 });
  }

  // Consume a credit before doing any paid work.
  const { data: remaining, error: creditErr } = await admin.rpc("spend_credit", { p_user: user.id });
  if (creditErr) return NextResponse.json({ error: creditErr.message }, { status: 500 });
  if (remaining === -1) {
    return NextResponse.json({ error: "You're out of credits." }, { status: 402 });
  }

  let apiKey: string;
  try {
    apiKey = decrypt(config.encrypted_api_key);
  } catch {
    return NextResponse.json({ error: "Stored key could not be read. Re-save it in Settings." }, { status: 500 });
  }

  const model = chat.model;
  const client = new OpenAI({ apiKey, baseURL: config.base_url, maxRetries: 2, timeout: 180_000 });

  // Prior turns, so the agent holds context within the chat.
  const { data: history } = await sb
    .from("messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    // Byte-stable prefix — this is what lets provider-side prompt caching hit.
    { role: "system", content: SYSTEM_PROMPT },
    ...(history ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: message },
  ];

  await admin.from("messages").insert({ chat_id: chatId, user_id: user.id, role: "user", content: message });

  if (chat.title === "New chat") {
    const title = message.trim().slice(0, 60) + (message.trim().length > 60 ? "…" : "");
    await admin.from("chats").update({ title }).eq("id", chatId);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      const steps: { kind: string; label: string; detail?: string }[] = [];
      const step = (kind: string, label: string, detail?: string) => {
        steps.push({ kind, label, detail });
        send({ t: "step", kind, label, detail });
      };

      let finalText = "";

      try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          step("thinking", i === 0 ? "Thinking" : "Reviewing what I found");

          const completion = await client.chat.completions.create({
            model,
            messages,
            tools: TOOLS,
            tool_choice: "auto",
            max_tokens: 8000,
          });

          const usage = completion.usage;
          if (usage) {
            const u = {
              input: usage.prompt_tokens ?? 0,
              output: usage.completion_tokens ?? 0,
              cached: cachedTokensFrom(usage),
            };
            await admin.from("usage_events").insert({
              chat_id: chatId,
              user_id: user.id,
              model,
              input_tokens: u.input,
              output_tokens: u.output,
              cached_tokens: u.cached,
              cost_usd: costOf(model, u),
            });
          }

          const choice = completion.choices[0];
          const msg = choice?.message;
          if (!msg) throw new Error("The model returned an empty response.");

          const toolCalls = msg.tool_calls ?? [];

          if (toolCalls.length === 0) {
            finalText = msg.content ?? "";
            break;
          }

          messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);

          for (const call of toolCalls) {
            if (call.type !== "function") continue;
            const name = call.function.name;
            let args: Record<string, string> = {};
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {
              // Fall through with empty args; the tool reports the problem back
              // to the model, which can retry.
            }

            let result: string;
            try {
              if (name === "web_search") {
                const query = args.query ?? "";
                step("search", "Searching the web", query);
                const r = await webSearch(query, args.depth === "basic" ? "basic" : "advanced");
                step("read", `Read ${r.results.length} source${r.results.length === 1 ? "" : "s"}`, query);
                result = formatSearchResult(query, r);
              } else if (name === "create_pdf_report") {
                const title = args.title || "Research Report";
                step("pdf", "Writing PDF report", title);
                const buf = await renderReportPdf(title, args.markdown || "");
                const path = `${user.id}/${chatId}/${Date.now()}-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50)}.pdf`;
                const { error: upErr } = await admin.storage
                  .from("reports")
                  .upload(path, buf, { contentType: "application/pdf", upsert: true });
                if (upErr) throw new Error(upErr.message);

                const { data: pub } = admin.storage.from("reports").getPublicUrl(path);
                await admin.from("artifacts").insert({
                  chat_id: chatId,
                  user_id: user.id,
                  title,
                  url: pub.publicUrl,
                });
                send({ t: "artifact", title, url: pub.publicUrl });
                result = `The PDF report "${title}" was created and is now visible to the user as a download. Do not repeat the report body in your reply — just briefly tell them it's ready and summarise what it covers in two or three sentences.`;
              } else {
                result = `Unknown tool: ${name}`;
              }
            } catch (err) {
              result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
              step("error", "A step failed", result);
            }

            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
        }

        if (!finalText) {
          finalText = "I reached my step limit before finishing. Ask me to continue and I'll pick up from here.";
        }

        send({ t: "message", text: finalText });

        await admin.from("messages").insert({
          chat_id: chatId,
          user_id: user.id,
          role: "assistant",
          content: finalText,
          steps,
        });

        send({ t: "done", credits: remaining });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);

        // The turn produced nothing usable, so give the credit back rather
        // than charging for a failed run.
        const { data: refunded } = await admin.rpc("grant_credits", {
          p_user: user.id,
          p_amount: 1,
          p_method: "refund",
          p_event_id: null,
        });

        send({ t: "error", message: detail, credits: refunded ?? remaining + 1 });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
