import { supabaseAdmin, currentUser } from "@/lib/supabase/server";
import SettingsForm from "./settings-form";
import { MODELS, fmtUSD } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  const { data: config } = await supabaseAdmin()
    .from("llm_configs")
    .select("provider, base_url, key_last4, default_model")
    .eq("user_id", user!.id)
    .maybeSingle();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-14 md:pt-0">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="font-[family-name:var(--font-display)] text-2xl">Settings</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-400">
          MicroManus never ships with a model key. Add your own below — it&apos;s encrypted before
          it&apos;s stored and only used to serve your requests.
        </p>

        <SettingsForm
          existing={
            config
              ? {
                  provider: config.provider,
                  baseUrl: config.base_url,
                  last4: config.key_last4 ?? "",
                  model: config.default_model,
                }
              : null
          }
        />

        <section className="mt-12">
          <h2 className="font-[family-name:var(--font-display)] text-lg">Model rates</h2>
          <p className="mt-1.5 text-sm text-ink-500">
            What MicroManus charges your usage against, per million tokens. Cached input is what
            you pay when the provider serves a repeated prefix from its cache.
          </p>

          <div className="mt-5 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-ink-800 bg-ink-900 text-left text-xs tracking-wide text-ink-500 uppercase">
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">Input</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cached</th>
                  <th className="px-4 py-2.5 text-right font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {MODELS.map((m) => (
                  <tr key={m.id} className="border-b border-ink-850 last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="text-ink-200">{m.label}</span>
                      <span className="ml-2 font-[family-name:var(--font-mono)] text-xs text-ink-600">
                        {m.context}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-[family-name:var(--font-mono)] text-xs text-ink-400">
                      ${m.in.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-[family-name:var(--font-mono)] text-xs text-ember-400">
                      ${m.cachedIn.toFixed(3)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-[family-name:var(--font-mono)] text-xs text-ink-400">
                      ${m.out.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-600">
            Example: a 20k-token input with 15k served from cache on Claude Sonnet 5 costs{" "}
            {fmtUSD((5000 * 3 + 15000 * 0.3) / 1_000_000)} instead of{" "}
            {fmtUSD((20000 * 3) / 1_000_000)}.
          </p>
        </section>
      </div>
    </div>
  );
}
