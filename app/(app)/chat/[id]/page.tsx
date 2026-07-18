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

  const [{ data: messages }, { data: artifacts }, { data: profile }] = await Promise.all([
    sb
      .from("messages")
      .select("id, role, content, steps, created_at")
      .eq("chat_id", id)
      .order("created_at", { ascending: true }),
    sb.from("artifacts").select("id, title, url, created_at").eq("chat_id", id).order("created_at"),
    sb.from("profiles").select("credits").eq("id", user!.id).maybeSingle(),
  ]);

  return (
    <ChatView
      chatId={chat.id}
      model={chat.model}
      initialMessages={(messages ?? []) as StoredMessage[]}
      artifacts={(artifacts ?? []) as Artifact[]}
      credits={profile?.credits ?? 0}
      autoSend={q ?? null}
    />
  );
}
