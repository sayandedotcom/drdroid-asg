import { notFound } from "next/navigation";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import ChatView, { type StoredMessage, type Artifact } from "./chat-view";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;

  const user = await currentUser();
  const sb = await supabaseServer();

  const { data: chat } = await sb
    .from("chats")
    .select("id, title, model")
    .eq("id", id)
    .maybeSingle();
  if (!chat) notFound();

  const [{ data: messages }, { data: artifacts }, { data: profile }, { data: events }] =
    await Promise.all([
      sb
        .from("messages")
        .select("id, role, content, steps, created_at")
        .eq("chat_id", id)
        .order("created_at", { ascending: true }),
      sb
        .from("artifacts")
        .select("id, title, url, created_at")
        .eq("chat_id", id)
        .order("created_at"),
      sb.from("profiles").select("credits").eq("id", user!.id).maybeSingle(),
      sb
        .from("usage_events")
        .select("input_tokens, output_tokens, cached_tokens, cost_usd")
        .eq("chat_id", id),
    ]);

  // One row per model call, so a chat is the sum of its rows — the same
  // aggregation the /usage page does, scoped to this chat.
  const usage = (events ?? []).reduce(
    (acc, e) => ({
      calls: acc.calls + 1,
      input: acc.input + e.input_tokens,
      output: acc.output + e.output_tokens,
      cached: acc.cached + e.cached_tokens,
      cost: acc.cost + Number(e.cost_usd),
    }),
    { calls: 0, input: 0, output: 0, cached: 0, cost: 0 }
  );

  return (
    <ChatView
      chatId={chat.id}
      model={chat.model}
      initialMessages={(messages ?? []) as StoredMessage[]}
      artifacts={(artifacts ?? []) as Artifact[]}
      credits={profile?.credits ?? 0}
      usage={usage}
      autoSend={q ?? null}
    />
  );
}
