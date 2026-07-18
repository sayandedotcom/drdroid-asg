"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function PaywallForm({
  sessionId,
  canceled,
  alreadyUnlocked,
}: {
  sessionId: string | null;
  canceled: boolean;
  alreadyUnlocked: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"coupon" | "card" | "confirm" | null>(
    sessionId ? "confirm" : null
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Returning from Stripe: confirm the payment server-side and grant credits.
  // The webhook does the same thing; whichever lands first wins and the other
  // is a no-op.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch("/api/checkout/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.ok) {
          setDone(true);
          setBusy(null);
          setTimeout(() => router.push("/settings"), 1200);
          return;
        }
        // Stripe can lag briefly before marking the session paid.
        if (res.status !== 402) {
          setError(body.error ?? "Could not confirm the payment.");
          setBusy(null);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      if (!cancelled) {
        if (alreadyUnlocked) {
          setDone(true);
          setBusy(null);
          setTimeout(() => router.push("/settings"), 800);
        } else {
          setError("Payment is still processing. Refresh in a moment.");
          setBusy(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, router, alreadyUnlocked]);

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setBusy("coupon");
    setError(null);
    const res = await fetch("/api/coupon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Something went wrong.");
      setBusy(null);
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/settings"), 900);
  }

  async function pay() {
    setBusy("card");
    setError(null);
    const res = await fetch("/api/checkout", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) {
      setError(body.error ?? "Could not start checkout.");
      setBusy(null);
      return;
    }
    window.location.href = body.url;
  }

  if (done) {
    return (
      <div className="rounded-xl border border-ember-600/40 bg-ember-500/[0.07] p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-ember-500/15">
          <svg viewBox="0 0 20 20" className="h-5 w-5 text-ember-400" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m5 10 3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="font-[family-name:var(--font-display)] text-xl">You&apos;re in</h2>
        <p className="mt-1.5 text-sm text-ink-400">5 credits added. Taking you to setup…</p>
      </div>
    );
  }

  if (busy === "confirm") {
    return (
      <div className="rounded-xl border border-ink-800 bg-ink-900/50 p-8 text-center">
        <p className="mm-pulse text-sm text-ink-400">Confirming your payment…</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/50 p-7 sm:p-8">
      <h1 className="font-[family-name:var(--font-display)] text-2xl">Unlock MicroManus</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-400">
        You need credits before you can run the agent. Both routes below give you the same thing:
        <span className="text-ink-100"> 5 research credits</span>. One credit covers one question,
        however many search and reasoning steps it takes.
      </p>

      {canceled && (
        <p className="mt-5 rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-xs text-ink-400">
          Checkout was cancelled — nothing was charged.
        </p>
      )}

      <form onSubmit={redeem} className="mt-7">
        <label htmlFor="coupon" className="text-xs font-medium tracking-wide text-ink-400 uppercase">
          Coupon code
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="coupon"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="SID_DRDROID"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-sm outline-none transition-colors placeholder:text-ink-600 focus:border-ember-600"
          />
          <button
            type="submit"
            disabled={busy !== null || !code.trim()}
            className="shrink-0 rounded-lg bg-ink-100 px-4 py-2.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
          >
            {busy === "coupon" ? "…" : "Redeem"}
          </button>
        </div>
      </form>

      <div className="my-7 flex items-center gap-3">
        <div className="h-px flex-1 bg-ink-800" />
        <span className="text-xs text-ink-600">or</span>
        <div className="h-px flex-1 bg-ink-800" />
      </div>

      <button
        onClick={pay}
        disabled={busy !== null}
        className="flex w-full items-center justify-between rounded-lg border border-ink-700 bg-ink-850 px-4 py-3.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-50"
      >
        <span>
          <span className="block text-sm font-medium">Pay with card</span>
          <span className="mt-0.5 block text-xs text-ink-500">Secure checkout via Stripe</span>
        </span>
        <span className="font-[family-name:var(--font-display)] text-lg">$5</span>
      </button>

      {error && (
        <p className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-300">
          {error}
        </p>
      )}

      <p className="mt-6 text-xs leading-relaxed text-ink-600">
        This charge only unlocks the app. Model usage is billed to your own API key, which you add
        on the next screen.
      </p>
    </div>
  );
}
