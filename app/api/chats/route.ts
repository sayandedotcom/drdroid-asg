import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin, currentUser } from "@/lib/supabase/server";
import { modelSpec } from "@/lib/models";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { model } = (await req.json().catch(() => ({}))) as { model?: string };

  // Fall back to the model saved in Settings.
  let chosen = model;
  if (!chosen || !modelSpec(chosen)) {
    const { data: config } = await supabaseAdmin()
      .from("llm_configs")
      .select("default_model")
      .eq("user_id", user.id)
      .maybeSingle();
    chosen = config?.default_model;
  }

  if (!chosen || !modelSpec(chosen)) {
    return NextResponse.json({ error: "Add your API key in Settings first." }, { status: 400 });
  }

  const sb = await supabaseServer();
  const { data, error } = await sb
    .from("chats")
    .insert({ user_id: user.id, model: chosen })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ id: data.id });
}

export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const sb = await supabaseServer();
  const { error } = await sb.from("chats").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
