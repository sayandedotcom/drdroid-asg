import Link from "next/link";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import { modelSpec, fmtUSD } from "@/lib/models";

export const dynamic = "force-dynamic";

interface Row {
  chatId: string;
  title: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
  createdAt: string;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

export default async function UsagePage() {
  const user = await currentUser();
  const sb = await supabaseServer();

  const [{ data: chats }, { data: events }] = await Promise.all([
    sb.from("chats").select("id, title, model, created_at").order("created_at", { ascending: false }),
    sb
      .from("usage_events")
      .select("chat_id, model, input_tokens, output_tokens, cached_tokens, cost_usd")
      .eq("user_id", user!.id),
  ]);

  const byChat = new Map<string, Row>();
  for (const c of chats ?? []) {
    byChat.set(c.id, {
      chatId: c.id,
      title: c.title,
      model: c.model,
      calls: 0,
      input: 0,
      output: 0,
      cached: 0,
      cost: 0,
      createdAt: c.created_at,
    });
  }

  for (const e of events ?? []) {
    const row = byChat.get(e.chat_id);
    if (!row) continue;
    row.calls += 1;
    row.input += e.input_tokens;
    row.output += e.output_tokens;
    row.cached += e.cached_tokens;
    row.cost += Number(e.cost_usd);
  }

  const rows = [...byChat.values()].filter((r) => r.calls > 0);

  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      input: acc.input + r.input,
      output: acc.output + r.output,
      cached: acc.cached + r.cached,
      cost: acc.cost + r.cost,
    }),
    { calls: 0, input: 0, output: 0, cached: 0, cost: 0 }
  );

  const cacheRate = totals.input > 0 ? (totals.cached / totals.input) * 100 : 0;

  const stats = [
    { label: "Total cost", value: fmtUSD(totals.cost), accent: true },
    { label: "Model calls", value: num(totals.calls) },
    { label: "Input tokens", value: num(totals.input) },
    { label: "Output tokens", value: num(totals.output) },
    { label: "Cached tokens", value: num(totals.cached), hint: `${cacheRate.toFixed(0)}% of input` },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-14 md:pt-0">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-[family-name:var(--font-display)] text-2xl">Usage &amp; cost</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-400">
          One row per chat. A single question makes several model calls as the agent searches and
          re-reasons, and every one of those calls is recorded here and priced at the rates for the
          model that chat used.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl border border-ink-800 bg-ink-900/50 px-4 py-3.5">
              <p className="text-xs text-ink-500">{s.label}</p>
              <p
                className={`mt-1.5 font-[family-name:var(--font-mono)] text-lg ${
                  s.accent ? "text-ember-400" : "text-ink-100"
                }`}
              >
                {s.value}
              </p>
              {s.hint && <p className="mt-0.5 text-xs text-ink-600">{s.hint}</p>}
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="mt-10 rounded-xl border border-ink-800 bg-ink-900/40 px-6 py-12 text-center">
            <p className="text-sm text-ink-400">No usage recorded yet.</p>
            <Link
              href="/chat"
              className="mt-4 inline-block rounded-lg bg-ink-100 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-white"
            >
              Start a chat
            </Link>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-ink-800 bg-ink-900 text-left text-xs tracking-wide text-ink-500 uppercase">
                  <th className="px-4 py-3 font-medium">Chat</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 text-right font-medium">Calls</th>
                  <th className="px-4 py-3 text-right font-medium">Input</th>
                  <th className="px-4 py-3 text-right font-medium">Cached</th>
                  <th className="px-4 py-3 text-right font-medium">Output</th>
                  <th className="px-4 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.chatId} className="border-b border-ink-850 last:border-0 hover:bg-ink-900/50">
                    <td className="max-w-xs px-4 py-3">
                      <Link href={`/chat/${r.chatId}`} className="block truncate hover:text-ember-400">
                        {r.title}
                      </Link>
                      <span className="text-xs text-ink-600">
                        {new Date(r.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-400">
                      {modelSpec(r.model)?.label ?? r.model}
                    </td>
                    <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-400">
                      {r.calls}
                    </td>
                    <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-400">
                      {num(r.input)}
                    </td>
                    <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ember-400">
                      {num(r.cached)}
                    </td>
                    <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-400">
                      {num(r.output)}
                    </td>
                    <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-100">
                      {fmtUSD(r.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-700 bg-ink-900">
                  <td className="px-4 py-3 text-xs tracking-wide text-ink-500 uppercase" colSpan={2}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-300">
                    {totals.calls}
                  </td>
                  <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-300">
                    {num(totals.input)}
                  </td>
                  <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ember-400">
                    {num(totals.cached)}
                  </td>
                  <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-ink-300">
                    {num(totals.output)}
                  </td>
                  <td className="px-4 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-ember-400">
                    {fmtUSD(totals.cost)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs leading-relaxed text-ink-600">
          Cached tokens are a subset of input tokens, billed at the provider&apos;s cache-read rate
          rather than the full input rate. MicroManus keeps the system prompt byte-stable so a
          cacheable prefix exists, but whether a cache hit actually happens is up to the provider:
          most require a minimum prefix length, and the OpenAI-compatible endpoints don&apos;t all
          report cache reads back. This column stays at zero when nothing is reported.
        </p>
      </div>
    </div>
  );
}
