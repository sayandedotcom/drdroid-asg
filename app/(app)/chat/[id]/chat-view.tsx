"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { modelSpec } from "@/lib/models";
import ChatCost, { type ChatUsage } from "./chat-cost";

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
  if (kind === "plan")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="3.5" cy="4" r="1" />
        <circle cx="3.5" cy="8" r="1" />
        <circle cx="3.5" cy="12" r="1" />
        <path d="M6.5 4h7M6.5 8h7M6.5 12h7" strokeLinecap="round" />
      </svg>
    );
  if (kind === "critique")
    return (
      <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="5.5" />
        <path d="m5.75 8 1.75 1.75 3-3.5" strokeLinecap="round" strokeLinejoin="round" />
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

// How much of a step's detail fits on one line before it is worth hiding the
// rest behind a click. Search queries sit well under this; the research plan and
// the critique's list of gaps run well over it.
const DETAIL_PREVIEW = 110;

function StepRow({ step, active }: { step: Step; active: boolean }) {
  const [open, setOpen] = useState(false);

  // The plan and the critique are the agent's own reasoning, and they were the
  // one thing the user could not read: the preview cut them off mid-sentence.
  // Short details still render inline exactly as before, so a search query does
  // not grow a chevron that reveals nothing.
  const detail = step.detail;
  const expandable = !!detail && detail.length > DETAIL_PREVIEW;

  const body = (
    <>
      <span className="mt-0.5">
        <StepIcon kind={step.kind} />
      </span>
      <span className="min-w-0 text-left">
        <span className="font-medium">{step.label}</span>
        {detail && !open && (
          <span className="ml-1.5 break-words text-ink-600">
            {expandable ? `${detail.slice(0, DETAIL_PREVIEW)}…` : detail}
          </span>
        )}
        {detail && open && (
          // The model writes these as numbered or bulleted lines, so the
          // newlines carry the structure and have to survive.
          <span className="mt-1 block break-words whitespace-pre-wrap text-ink-600">{detail}</span>
        )}
      </span>
    </>
  );

  const tone =
    step.kind === "error" ? "text-red-400" : active ? "text-ink-200" : "text-ink-500";

  return (
    <li className={`text-xs ${tone} ${active ? "mm-pulse" : ""}`}>
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-start gap-2 text-left hover:text-ink-300"
        >
          {body}
          <span aria-hidden className={`mt-0.5 ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
            ›
          </span>
        </button>
      ) : (
        <div className="flex items-start gap-2">{body}</div>
      )}
    </li>
  );
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <ol className="mb-4 space-y-1.5 border-l border-ink-800 pl-4">
      {steps.map((s, i) => (
        <StepRow key={i} step={s} active={live && i === steps.length - 1} />
      ))}
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
  usage,
  autoSend,
}: {
  chatId: string;
  model: string;
  initialMessages: StoredMessage[];
  artifacts: Artifact[];
  credits: number;
  usage: ChatUsage;
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
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The prompt of a turn that failed, kept so Retry can resend it. The message
  // itself stays on screen and in the database; only the reply is missing.
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const startedAutoSend = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, liveSteps, draft, running]);

  const send = useCallback(
    async (text: string, { retry = false }: { retry?: boolean } = {}) => {
      const prompt = text.trim();
      if (!prompt || running) return;

      setRunning(true);
      setError(null);
      setFailedPrompt(null);
      setLiveSteps([]);
      setDraft("");
      setInput("");
      // A retry's message bubble is already on screen from the turn that failed.
      if (!retry) {
        setTurns((t) => [...t, { kind: "user", id: `tmp-${Date.now()}`, text: prompt }]);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // Declared outside the try so the abort path can keep whatever the agent
      // had already produced before the user stopped it.
      const steps: Step[] = [];
      let streamed = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatId, message: prompt, retry }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
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
            } else if (ev.t === "delta") {
              // `restart` marks a fresh answer — a revision after the agent's
              // self-review replaces the draft rather than appending to it.
              streamed = ev.restart ? String(ev.text) : streamed + String(ev.text);
              setDraft(streamed);
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

        // The stream can end without a `message` event if the connection drops
        // mid-run. Committing `finalText` blindly would append a silent empty
        // bubble, so fall back to whatever already streamed and say so.
        if (!finalText) {
          if (!streamed.trim()) {
            throw new Error("The connection dropped before the agent replied. Please try again.");
          }
          finalText = streamed;
          steps.push({
            kind: "error",
            label: "Response interrupted",
            detail: "The connection dropped before the agent finished — this reply may be incomplete.",
          });
        }

        setTurns((t) => [
          ...t,
          { kind: "assistant", id: `a-${Date.now()}`, text: finalText, steps },
        ]);
        setLiveSteps([]);
        setDraft("");
        router.refresh();
      } catch (err) {
        setLiveSteps([]);
        setDraft("");

        // Stopping is a deliberate act, not a failure: keep what the agent had
        // written rather than discarding it, and say nothing in red.
        // Matched on name rather than type: aborting mid-read rejects with a
        // DOMException in the browser but a plain Error elsewhere.
        if (err instanceof Error && err.name === "AbortError") {
          const partial = streamed.trim();
          if (partial) {
            const stopped: Step[] = [
              ...steps,
              {
                kind: "error",
                label: "Stopped",
                detail: "You stopped this answer — it may be incomplete.",
              },
            ];
            setTurns((t) => [
              ...t,
              { kind: "assistant", id: `a-${Date.now()}`, text: partial, steps: stopped },
            ]);
            // The agent was cancelled before it could save this itself, and the
            // next turn reads its context back out of the database.
            await fetch("/api/chat/stop", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chatId, content: partial, steps: stopped }),
            }).catch(() => {});
          }
          router.refresh();
          return;
        }

        setError(err instanceof Error ? err.message : String(err));
        setFailedPrompt(prompt);
      } finally {
        abortRef.current = null;
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
        <div className="flex items-center gap-3">
          {/* Read straight from props, never copied into state: router.refresh()
              after each turn re-renders the server component and this updates
              with it. */}
          <ChatCost usage={usage} />
          <span className="text-xs text-ink-500">
            {credits} credit{credits === 1 ? "" : "s"} left
          </span>
        </div>
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
              {draft && (
                <div className="prose-mm text-sm text-ink-200">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
                </div>
              )}
              {liveSteps.length === 0 && !draft && (
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
              <p>{error}</p>
              {failedPrompt && (
                <button
                  type="button"
                  onClick={() => send(failedPrompt, { retry: true })}
                  disabled={running || credits <= 0}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-red-800/70 px-2.5 py-1 text-xs font-medium text-red-200 transition-colors hover:border-red-600 hover:bg-red-900/40 disabled:opacity-40"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M13 8a5 5 0 1 1-1.5-3.5" strokeLinecap="round" />
                    <path d="M13 2.5V5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Retry
                </button>
              )}
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
            {running ? (
              // Deliberately not `type="submit"`, and never disabled by the
              // empty-input rule: mid-run there is nothing typed to gate on.
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="mb-0.5 flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 px-3.5 py-1.5 text-sm font-medium text-ink-200 transition-colors hover:border-ink-500 hover:text-ink-100"
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || credits <= 0}
                className="mb-0.5 shrink-0 rounded-lg bg-ink-100 px-3.5 py-1.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-600">
            Holds context across the whole chat. 1 credit per message — stopping
            early still costs it, and keeps what was written.
          </p>
        </form>
      </div>
    </div>
  );
}
