import SignInButton from "./sign-in-button";

const STEPS = [
  {
    n: "01",
    title: "Sign in with GitHub",
    body: "No password, no signup form. One click and you have an account.",
  },
  {
    n: "02",
    title: "Unlock with a coupon or $5",
    body: "Enter a coupon code, or pay by card. Either way you get 5 research credits.",
  },
  {
    n: "03",
    title: "Add your own model key",
    body: "Paste an API key from Anthropic, OpenAI, Google or Moonshot. Your key, your billing, encrypted at rest.",
  },
  {
    n: "04",
    title: "Ask a real question",
    body: "The agent searches, reads, reasons, searches again — and can hand you a PDF report at the end.",
  },
];

export default function Landing() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[36rem] w-[64rem] -translate-x-1/2 rounded-full opacity-[0.16] blur-[120px]"
        style={{ background: "radial-gradient(closest-side, #e2833c, transparent)" }}
      />

      <div className="relative mx-auto flex max-w-5xl flex-col px-6 py-10 sm:py-16">
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-[family-name:var(--font-display)] text-xl tracking-tight">
              MicroManus
            </span>
            <span className="hidden text-xs text-ink-500 sm:inline">deep research agent</span>
          </div>
        </header>

        <section className="mt-20 max-w-3xl sm:mt-28">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/60 px-3 py-1 text-xs text-ink-400">
            <span className="h-1.5 w-1.5 rounded-full bg-ember-500" />
            Bring your own model key
          </p>

          <h1 className="font-[family-name:var(--font-display)] text-4xl leading-[1.12] tracking-tight sm:text-6xl">
            Ask a hard question.
            <br />
            <span className="text-ember-400">Get a researched answer.</span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-400 sm:text-lg">
            MicroManus searches the live web, reads what it finds, reconsiders, and searches
            again — as many times as the question needs. When you want something you can hand to
            someone else, it writes a formatted PDF report.
          </p>

          <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <SignInButton />
            <span className="text-xs text-ink-500">5 credits to start · coupon or $5</span>
          </div>
        </section>

        <section className="mt-24 grid gap-x-10 gap-y-8 border-t border-ink-800 pt-12 sm:mt-32 sm:grid-cols-2">
          {STEPS.map((s) => (
            <div key={s.n} className="flex gap-4">
              <span className="pt-1 font-[family-name:var(--font-mono)] text-xs text-ember-600">
                {s.n}
              </span>
              <div>
                <h3 className="text-sm font-medium text-ink-100">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{s.body}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="mt-20 rounded-xl border border-ink-800 bg-ink-900/40 p-6 sm:p-8">
          <h2 className="font-[family-name:var(--font-display)] text-lg">
            Every run is costed, down to the token
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-500">
            The agent loop makes several model calls per question. MicroManus records each one and
            breaks the spend down by input, output, and cached tokens — priced at the real rates for
            the model you picked. The Usage page shows it per chat and in total.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {["Claude Opus 4.8", "Claude Sonnet 5", "GPT-5", "Gemini 2.5 Pro", "Kimi K2"].map((m) => (
              <span
                key={m}
                className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 font-[family-name:var(--font-mono)] text-xs text-ink-400"
              >
                {m}
              </span>
            ))}
            <span className="rounded-md px-2.5 py-1 text-xs text-ink-600">+ 3 more</span>
          </div>
        </section>

        <footer className="mt-20 border-t border-ink-800 pt-6 pb-4 text-xs text-ink-600">
          Your API key is encrypted before storage and only ever used to serve your own requests.
        </footer>
      </div>
    </main>
  );
}
