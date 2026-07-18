"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { modelSpec } from "@/lib/models";

export interface Step {
  kind: string;
  label: string;
  detail?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: Step[] | null;
  created_at: string;
}

export interface Artifact {
  id: string;
  title: string;
  url: string;
  created_at: string;
}

type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; steps: Step[] };

function StepIcon({ kind }: { kind: string }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (kind === "search")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" strokeLinecap="round" />
      </svg>
    );
  if (kind === "read")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M2.5 3.5h11v9h-11z" />
        <path d="M5 6.5h6M5 9h4" strokeLinecap="round" />
      </svg>
    );
  if (kind === "pdf")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 2h5l3 3v9H4z" />
        <path d="M9 2v3h3" />
      </svg>
    );
  if (kind === "error")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5.5v3M8 10.5v.01" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" strokeLinecap="round" />
    </svg>
  );
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <ol className="mb-4 space-y-1.5 border-l border-ink-800 pl-4">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        const active = live && isLast;
        return (
          <li
            key={i}
            className={`flex items-start gap-2 text-xs ${
              s.kind === "error" ? "text-red-400" : active ? "text-ink-200" : "text-ink-500"
            } ${active ? "mm-pulse" : ""}`}
          >
            <span className="mt-0.5">
              <StepIcon kind={s.kind} />
            </span>
            <span className="min-w-0">
              <span className="font-medium">{s.label}</span>
              {s.detail && (
                <span className="ml-1.5 break-words text-ink-600">
                  {s.detail.length > 110 ? `${s.detail.slice(0, 110)}…` : s.detail}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ArtifactCard({ a }: { a: Artifact }) {
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noreferrer"
      className="mt-4 flex items-center gap-3 rounded-xl border border-ember-600/40 bg-ember-500/[0.07] px-4 py-3 transition-colors hover:border-ember-500 hover:bg-ember-500/[0.12]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ember-500/15 text-ember-400">
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M9 2v3h3" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink-100">{a.title}</span>
        <span className="block text-xs text-ink-500">PDF report · click to download</span>
      </span>
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13h10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

export default function ChatView({
  chatId,
  model,
  initialMessages,
  artifacts: initialArtifacts,
  credits: initialCredits,
  autoSend,
}: {
  chatId: string;
  model: string;
  initialMessages: StoredMessage[];
  artifacts: Artifact[];
  credits: number;
  autoSend: string | null;
}) {
  const router = useRouter();

  const [turns, setTurns] = useState<Turn[]>(() =>
    initialMessages.map((m) =>
      m.role === "user"
        ? ({ kind: "user", id: m.id, text: m.content } as Turn)
        : ({ kind: "assistant", id: m.id, text: m.content, steps: m.steps ?? [] } as Turn)
    )
  );
  const [artifacts, setArtifacts] = useState<Artifact[]>(initialArtifacts);
  const [credits, setCredits] = useState(initialCredits);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [liveSteps, setLiveSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const startedAutoSend = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, liveSteps, running]);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || running) return;

      setRunning(true);
      setError(null);
      setLiveSteps([]);
      setInput("");
      setTurns((t) => [...t, { kind: "user", id: `tmp-${Date.now()}`, text: prompt }]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatId, message: prompt }),
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const steps: Step[] = [];
        let finalText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;

            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (ev.t === "step") {
              steps.push({
                kind: String(ev.kind),
                label: String(ev.label),
                detail: ev.detail ? String(ev.detail) : undefined,
              });
              setLiveSteps([...steps]);
            } else if (ev.t === "artifact") {
              setArtifacts((a) => [
                ...a,
                {
                  id: `live-${Date.now()}`,
                  title: String(ev.title),
                  url: String(ev.url),
                  created_at: new Date().toISOString(),
                },
              ]);
            } else if (ev.t === "message") {
              finalText = String(ev.text);
            } else if (ev.t === "done") {
              if (typeof ev.credits === "number") setCredits(ev.credits);
            } else if (ev.t === "error") {
              // The server refunds the credit when a turn fails outright.
              if (typeof ev.credits === "number") setCredits(ev.credits);
              throw new Error(String(ev.message));
            }
          }
        }

        setTurns((t) => [
          ...t,
          { kind: "assistant", id: `a-${Date.now()}`, text: finalText, steps },
        ]);
        setLiveSteps([]);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLiveSteps([]);
      } finally {
        setRunning(false);
      }
    },
    [chatId, running, router]
  );

  // A chat started from the index page carries its first prompt in ?q=.
  useEffect(() => {
    if (autoSend && !startedAutoSend.current && turns.length === 0) {
      startedAutoSend.current = true;
      window.history.replaceState(null, "", `/chat/${chatId}`);
      send(autoSend);
    }
  }, [autoSend, chatId, send, turns.length]);

  const spec = modelSpec(model);

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-14 md:pt-0">
      <header className="flex items-center justify-between border-b border-ink-800 px-6 py-3">
        <span className="font-[family-name:var(--font-mono)] text-xs text-ink-500">
          {spec?.label ?? model}
        </span>
        <span className="text-xs text-ink-500">
          {credits} credit{credits === 1 ? "" : "s"} left
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {turns.map((turn) =>
            turn.kind === "user" ? (
              <div key={turn.id} className="mb-8 flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink-800 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={turn.id} className="mb-10">
                <StepList steps={turn.steps} live={false} />
                <div className="prose-mm text-sm text-ink-200">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
                </div>
              </div>
            )
          )}

          {running && (
            <div className="mb-10">
              <StepList steps={liveSteps} live />
              {liveSteps.length === 0 && (
                <p className="mm-pulse text-xs text-ink-500">Starting…</p>
              )}
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="mb-8">
              {artifacts.map((a) => (
                <ArtifactCard key={a.id} a={a} />
              ))}
            </div>
          )}

          {error && (
            <div className="mb-8 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm leading-relaxed text-red-300">
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-ink-800 px-6 py-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="mx-auto max-w-3xl"
        >
          <div className="flex items-end gap-2 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 focus-within:border-ember-600">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              disabled={running || credits <= 0}
              placeholder={
                credits <= 0 ? "You're out of credits." : "Ask a follow-up…"
              }
              className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-600 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={running || !input.trim() || credits <= 0}
              className="mb-0.5 shrink-0 rounded-lg bg-ink-100 px-3.5 py-1.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
            >
              {running ? "…" : "Send"}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-600">
            Holds context across the whole chat. 1 credit per message.
          </p>
        </form>
      </div>
    </div>
  );
}
