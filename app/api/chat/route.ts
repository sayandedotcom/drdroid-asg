import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin, currentUser } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Owns everything that must happen before the agent runs — auth, ownership,
 * credit accounting, decrypting the user's model key — then hands the turn to
 * the Python LangGraph service and streams its SSE straight back.
 *
 * The key is decrypted here and passed over an authenticated server-to-server
 * call, so ENCRYPTION_SECRET never leaves this process.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { chatId, message, retry } = (await req.json()) as {
    chatId?: string;
    message?: string;
    retry?: boolean;
  };
  if (!chatId || !message?.trim()) {
    return NextResponse.json({ error: "chatId and message are required." }, { status: 400 });
  }

  const serviceUrl = process.env.AGENT_SERVICE_URL;
  const serviceSecret = process.env.AGENT_SERVICE_SECRET;
  if (!serviceUrl || !serviceSecret) {
    return NextResponse.json({ error: "The agent service is not configured." }, { status: 500 });
  }

  const admin = supabaseAdmin();
  const sb = await supabaseServer();

  // RLS enforces ownership too; failing here just gives a clearer error.
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

  let apiKey: string;
  try {
    apiKey = decrypt(config.encrypted_api_key);
  } catch {
    return NextResponse.json(
      { error: "Stored key could not be read. Re-save it in Settings." },
      { status: 500 }
    );
  }

  // A turn that failed still inserted its user message below, and the credit was
  // refunded but the row was left behind. Retrying the same text would otherwise
  // read that orphan into the history *and* insert it again, so the model would
  // see the question twice. Drop it first and the retry becomes an ordinary send.
  if (retry) {
    const { data: last } = await sb
      .from("messages")
      .select("id, role")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Only ever an unanswered question: if an assistant reply is newest then
    // nothing was orphaned and there is nothing to clean up.
    if (last?.role === "user") {
      await admin.from("messages").delete().eq("id", last.id);
    }
  }

  // Prior turns, so the agent holds context within this chat. Read before the
  // new message is inserted so it isn't duplicated.
  const { data: history } = await sb
    .from("messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  // Consume a credit before any paid work. The agent service refunds it if the
  // turn fails outright.
  const { data: remaining, error: creditErr } = await admin.rpc("spend_credit", { p_user: user.id });
  if (creditErr) return NextResponse.json({ error: creditErr.message }, { status: 500 });
  if (remaining === -1) return NextResponse.json({ error: "You're out of credits." }, { status: 402 });

  await admin
    .from("messages")
    .insert({ chat_id: chatId, user_id: user.id, role: "user", content: message });

  if (chat.title === "New chat") {
    const trimmed = message.trim();
    const title = trimmed.slice(0, 60) + (trimmed.length > 60 ? "…" : "");
    await admin.from("chats").update({ title }).eq("id", chatId);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${serviceUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceSecret}`,
      },
      body: JSON.stringify({
        user_id: user.id,
        chat_id: chatId,
        model: chat.model,
        base_url: config.base_url,
        api_key: apiKey,
        message,
        history: history ?? [],
        credits_remaining: remaining,
      }),
    });
  } catch (err) {
    // Never reached the service, so nothing downstream can refund — do it here.
    const { data: refunded } = await admin.rpc("grant_credits", {
      p_user: user.id,
      p_amount: 1,
      p_method: "refund",
      p_event_id: null,
    });
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not reach the agent service: ${detail}`, credits: refunded },
      { status: 502 }
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    const { data: refunded } = await admin.rpc("grant_credits", {
      p_user: user.id,
      p_amount: 1,
      p_method: "refund",
      p_event_id: null,
    });
    return NextResponse.json(
      {
        error: `Agent service error (${upstream.status}). ${detail.slice(0, 200)}`,
        credits: refunded,
      },
      { status: 502 }
    );
  }

  // Pass the SSE frames through untouched — the wire format is exactly what
  // chat-view.tsx already parses — but watch for a terminal event on the way
  // past. The agent service refunds the credit when it catches an exception, so
  // a stream that ends without `done` or `error` means it died without getting
  // the chance: the function timed out, the process crashed, a proxy cut it.
  // Nothing downstream can refund that, so do it here.
  const decoder = new TextDecoder();
  let sawTerminal = false;

  const watch = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sawTerminal && /"t":\s*"(done|error)"/.test(decoder.decode(chunk, { stream: true }))) {
        sawTerminal = true;
      }
      controller.enqueue(chunk);
    },
    async flush() {
      if (sawTerminal) return;
      await admin.rpc("grant_credits", {
        p_user: user.id,
        p_amount: 1,
        p_method: "refund",
        p_event_id: null,
      });
    },
  });

  return new Response(upstream.body.pipeThrough(watch), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
