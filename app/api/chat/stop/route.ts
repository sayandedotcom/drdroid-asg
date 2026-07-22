import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin, currentUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Saves what a stopped turn had already written.
 *
 * Aborting the /api/chat stream cancels the agent mid-run (the service cancels
 * the episode task when the client disconnects), so it never reaches its own
 * save_assistant_message. Without this the partial answer would live only in
 * React state: gone on reload, and invisible to the next turn, which builds its
 * context by replaying this table.
 *
 * Credits and usage are not touched here — both settled server-side while the
 * turn was still running.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { chatId, content, steps } = (await req.json()) as {
    chatId?: string;
    content?: string;
    steps?: unknown[];
  };
  if (!chatId) return NextResponse.json({ error: "chatId is required." }, { status: 400 });

  // An empty assistant bubble reads worse than no bubble at all — a turn stopped
  // during planning has nothing worth keeping.
  if (!content?.trim()) return NextResponse.json({ saved: false });

  // Read through the user's own client so RLS proves ownership before the admin
  // client writes on their behalf.
  const sb = await supabaseServer();
  const { data: chat } = await sb.from("chats").select("id").eq("id", chatId).maybeSingle();
  if (!chat) return NextResponse.json({ error: "Chat not found." }, { status: 404 });

  const { error } = await supabaseAdmin().from("messages").insert({
    chat_id: chatId,
    user_id: user.id,
    role: "assistant",
    content,
    steps: steps ?? [],
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ saved: true });
}
