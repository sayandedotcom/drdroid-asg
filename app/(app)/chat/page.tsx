import Link from "next/link";
import { supabaseAdmin, currentUser } from "@/lib/supabase/server";
import NewChatComposer from "./new-chat-composer";

export const dynamic = "force-dynamic";

export default async function ChatIndex() {
  const user = await currentUser();
  const { data: config } = await supabaseAdmin()
    .from("llm_configs")
    .select("default_model, provider")
    .eq("user_id", user!.id)
    .maybeSingle();

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto pt-14 md:pt-0">
      <div className="w-full max-w-2xl px-6 py-12">
        <h1 className="font-[family-name:var(--font-display)] text-3xl leading-tight">
          What do you want researched?
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-400">
          Ask something that needs looking up. The agent will search, read the results, and keep
          going until it has an answer — then write a PDF if you ask for one.
        </p>

        {config ? (
          <NewChatComposer model={config.default_model} provider={config.provider} />
        ) : (
          <div className="mt-8 rounded-xl border border-ember-600/40 bg-ember-500/[0.07] p-5">
            <h2 className="text-sm font-medium text-ink-100">Add your API key first</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-400">
              MicroManus runs on your own model key — nothing is bundled with the app.
            </p>
            <Link
              href="/settings"
              className="mt-4 inline-block rounded-lg bg-ink-100 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
            >
              Go to Settings
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
