import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin, currentUser } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";
import { modelSpec } from "@/lib/models";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { provider, baseUrl, apiKey, model } = (await req.json()) as {
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };

  if (!apiKey?.trim()) return NextResponse.json({ error: "An API key is required." }, { status: 400 });
  if (!baseUrl?.trim()) return NextResponse.json({ error: "A base URL is required." }, { status: 400 });
  if (!model || !modelSpec(model)) {
    return NextResponse.json({ error: "Pick a supported model." }, { status: 400 });
  }

  const key = apiKey.trim();

  // Verify the key works before saving, so failures surface here rather than
  // mid-conversation after a credit has been spent.
  //
  // The token cap has to be spelled two different ways: the reasoning models
  // (gpt-5, gpt-5-mini) reject `max_tokens` and require `max_completion_tokens`,
  // while the Anthropic and Moonshot compatibility endpoints only know the
  // former. Try the common spelling, then retry with the other rather than
  // telling someone their perfectly good key doesn't work.
  try {
    const client = new OpenAI({ apiKey: key, baseURL: baseUrl.trim(), maxRetries: 0, timeout: 30_000 });
    const probe = { model, messages: [{ role: "user" as const, content: "Reply with the word: ok" }] };
    try {
      await client.chat.completions.create({ ...probe, max_tokens: 16 });
    } catch (first) {
      const msg = first instanceof Error ? first.message : String(first);
      if (!/max_tokens|max_completion_tokens/i.test(msg)) throw first;
      await client.chat.completions.create({ ...probe, max_completion_tokens: 16 });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `That key didn't work against ${baseUrl}. ${detail.slice(0, 300)}` },
      { status: 400 }
    );
  }

  const { error } = await supabaseAdmin().from("llm_configs").upsert(
    {
      user_id: user.id,
      provider: provider ?? "openai",
      base_url: baseUrl.trim(),
      encrypted_api_key: encrypt(key),
      key_last4: key.slice(-4),
      default_model: model,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  await supabaseAdmin().from("llm_configs").delete().eq("user_id", user.id);
  return NextResponse.json({ ok: true });
}
