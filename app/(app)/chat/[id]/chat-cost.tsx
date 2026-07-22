"use client";

import { useState } from "react";
import { fmtUSD } from "@/lib/models";

export interface ChatUsage {
  calls: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The running cost of one chat, in its header.
 *
 * The numbers come from the server component as a prop rather than from a
 * client-side tally of the stream. The agent service settles every usage_events
 * write before it emits `done`, and ChatView calls router.refresh() on that
 * event — which re-renders this route's Server Components and hands down a new
 * prop without disturbing the `open` state below. So the reading here is always
 * the same aggregate the /usage page shows, with no second source of truth to
 * drift.
 */
export default function ChatCost({ usage }: { usage: ChatUsage }) {
  const [open, setOpen] = useState(false);

  // A chat with no model calls yet has nothing to say; "$0.00" would read as a
  // broken counter rather than an empty one.
  if (usage.calls === 0) return null;

  const parts = [
    { label: "Input", value: usage.input },
    { label: "Cached", value: usage.cached, accent: true },
    { label: "Output", value: usage.output },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-ink-900 hover:text-ink-300"
      >
        <span className="font-[family-name:var(--font-mono)] text-ember-400">
          {fmtUSD(usage.cost)}
        </span>
        <span>
          {usage.calls} call{usage.calls === 1 ? "" : "s"}
        </span>
      </button>

      {open && (
        <div className="absolute top-full left-1/2 z-10 mt-1.5 -translate-x-1/2 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 shadow-lg">
          <div className="flex gap-5">
            {parts.map((p) => (
              <div key={p.label}>
                <p className="text-xs whitespace-nowrap text-ink-500">{p.label}</p>
                <p
                  className={`mt-0.5 font-[family-name:var(--font-mono)] text-xs ${
                    p.accent ? "text-ember-400" : "text-ink-200"
                  }`}
                >
                  {num(p.value)}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2.5 max-w-[15rem] text-xs leading-relaxed text-ink-600">
            Tokens across every model call in this chat. Cached tokens are a subset of input,
            billed at the cache-read rate.
          </p>
        </div>
      )}
    </div>
  );
}
