"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODELS } from "@/lib/models";

const EXAMPLES = [
  "Create a report explaining the recent forest fires in California — what is causing them and what can be done to avoid them.",
  "What changed in EU AI regulation this year, and who does it actually affect?",
  "Compare the current state of solid-state batteries across the main players.",
];

export default function NewChatComposer({ model }: { model: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState(model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(prompt: string) {
    const q = prompt.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);

    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: chosen }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || !body.id) {
      setError(body.error ?? "Could not start a chat.");
      setBusy(false);
      return;
    }

    // The conversation view picks up ?q= and sends it automatically.
    router.push(`/chat/${body.id}?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="mt-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(text);
        }}
      >
        <div className="rounded-xl border border-ink-700 bg-ink-900 focus-within:border-ember-600">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                start(text);
              }
            }}
            rows={3}
            placeholder="Ask anything that needs research…"
            className="w-full resize-none bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-ink-600"
          />
          <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-3 py-2.5">
            <select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="max-w-[60%] truncate rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-ink-300 outline-none focus:border-ember-600"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="rounded-lg bg-ink-100 px-4 py-1.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
            >
              {busy ? "Starting…" : "Research"}
            </button>
          </div>
        </div>
      </form>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <p className="mt-8 mb-3 text-xs tracking-wide text-ink-600 uppercase">Try one of these</p>
      <div className="space-y-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => start(ex)}
            disabled={busy}
            className="w-full rounded-lg border border-ink-800 bg-ink-900/40 px-4 py-3 text-left text-sm leading-relaxed text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 disabled:opacity-50"
          >
            {ex}
          </button>
        ))}
      </div>

      <p className="mt-6 text-xs text-ink-600">Each question costs 1 credit, however many steps it takes.</p>
    </div>
  );
}
