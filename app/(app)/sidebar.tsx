"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

interface ChatRow {
  id: string;
  title: string;
  created_at: string;
}

export default function Sidebar({
  chats,
  credits,
  email,
  hasKey,
}: {
  chats: ChatRow[];
  credits: number;
  email: string;
  hasKey: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);

  async function newChat() {
    if (!hasKey) {
      router.push("/settings");
      return;
    }
    setCreating(true);
    const res = await fetch("/api/chats", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setCreating(false);
    setOpen(false);
    if (res.ok && body.id) {
      router.push(`/chat/${body.id}`);
      router.refresh();
    } else {
      router.push("/settings");
    }
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.push("/");
    router.refresh();
  }

  const nav = (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-3">
        <Link href="/chat" className="font-[family-name:var(--font-display)] text-lg tracking-tight">
          MicroManus
        </Link>
      </div>

      <div className="px-3">
        <button
          onClick={newChat}
          disabled={creating}
          className="flex w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
          {creating ? "Starting…" : "New chat"}
        </button>
      </div>

      <nav className="mt-5 min-h-0 flex-1 overflow-y-auto px-3">
        {chats.length > 0 && (
          <p className="px-2 pb-2 text-xs tracking-wide text-ink-600 uppercase">Chats</p>
        )}
        <ul className="space-y-0.5">
          {chats.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            return (
              <li key={c.id}>
                <Link
                  href={`/chat/${c.id}`}
                  onClick={() => setOpen(false)}
                  className={`block truncate rounded-md px-2.5 py-2 text-sm transition-colors ${
                    active
                      ? "bg-ink-800 text-ink-100"
                      : "text-ink-400 hover:bg-ink-850 hover:text-ink-300"
                  }`}
                >
                  {c.title}
                </Link>
              </li>
            );
          })}
        </ul>
        {chats.length === 0 && (
          <p className="px-2 text-xs leading-relaxed text-ink-600">
            No chats yet. Start one above.
          </p>
        )}
      </nav>

      <div className="border-t border-ink-800 p-3">
        <div className="mb-2 flex items-center justify-between rounded-lg bg-ink-850 px-3 py-2.5">
          <span className="text-xs text-ink-400">Credits</span>
          <span
            className={`font-[family-name:var(--font-mono)] text-sm ${
              credits > 0 ? "text-ember-400" : "text-red-400"
            }`}
          >
            {credits}
          </span>
        </div>

        <Link
          href="/usage"
          onClick={() => setOpen(false)}
          className={`block rounded-md px-3 py-2 text-sm transition-colors ${
            pathname === "/usage" ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"
          }`}
        >
          Usage &amp; cost
        </Link>
        <Link
          href="/settings"
          onClick={() => setOpen(false)}
          className={`block rounded-md px-3 py-2 text-sm transition-colors ${
            pathname === "/settings" ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"
          }`}
        >
          Settings
          {!hasKey && (
            <span className="ml-2 rounded bg-ember-500/15 px-1.5 py-0.5 text-[10px] text-ember-400">
              add key
            </span>
          )}
        </Link>

        <div className="mt-3 border-t border-ink-800 pt-3">
          <p className="truncate px-3 text-xs text-ink-600">{email}</p>
          <button
            onClick={signOut}
            className="mt-1 px-3 text-xs text-ink-500 transition-colors hover:text-ink-300"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-ink-800 bg-ink-950 px-4 py-3 md:hidden">
        <span className="font-[family-name:var(--font-display)]">MicroManus</span>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          className="rounded-md border border-ink-700 p-1.5"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-ink-800 bg-ink-900 transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {nav}
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
    </>
  );
}
