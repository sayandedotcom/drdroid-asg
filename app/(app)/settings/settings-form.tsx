"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROVIDERS, modelSpec, modelsFor, type Provider } from "@/lib/models";

export default function SettingsForm({
  existing,
}: {
  existing: { provider: string; baseUrl: string; last4: string; model: string } | null;
}) {
  const router = useRouter();

  // The saved row is free-form text the registry may no longer recognise: a
  // model can be retired between sessions. Trusting it silently desynced the
  // form from its own <select> -- the dropdown fell back to showing its first
  // option while state still held the dead id, so an untouched form POSTed a
  // model the server rejects with "Pick a supported model." Validate here so a
  // retired id degrades to this provider's first live model instead.
  const savedProvider = existing?.provider;
  const initialProvider: Provider =
    savedProvider && savedProvider in PROVIDERS ? (savedProvider as Provider) : "anthropic";
  const initialModel =
    existing?.model && modelSpec(existing.model)
      ? existing.model
      : modelsFor(initialProvider)[0].id;

  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || PROVIDERS[initialProvider].baseUrl);
  const [model, setModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function pickProvider(p: Provider) {
    setProvider(p);
    setBaseUrl(PROVIDERS[p].baseUrl);
    setModel(modelsFor(p)[0].id);
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, baseUrl, apiKey, model }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setError(body.error ?? "Could not save.");
      return;
    }
    setSaved(true);
    setApiKey("");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="mt-8 rounded-xl border border-ink-800 bg-ink-900/50 p-6">
      {existing && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-xs">
          <span className="text-ink-400">Key on file</span>
          <span className="font-[family-name:var(--font-mono)] text-ink-200">
            ••••{existing.last4}
          </span>
          <span className="text-ink-600">·</span>
          <span className="text-ink-400">{existing.model}</span>
        </div>
      )}

      <fieldset>
        <legend className="text-xs font-medium tracking-wide text-ink-400 uppercase">
          Provider
        </legend>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pickProvider(p)}
              className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                provider === p
                  ? "border-ember-600 bg-ember-500/10 text-ink-100"
                  : "border-ink-700 bg-ink-850 text-ink-400 hover:border-ink-600"
              }`}
            >
              {PROVIDERS[p].label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-6">
        <label htmlFor="model" className="text-xs font-medium tracking-wide text-ink-400 uppercase">
          Model
        </label>
        <select
          id="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 text-sm outline-none focus:border-ember-600"
        >
          {modelsFor(provider).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — ${m.in}/${m.out} per 1M in/out
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-ink-600">
          Cost is calculated at this model&apos;s rates. You can switch model per chat later.
        </p>
      </div>

      <div className="mt-6">
        <label htmlFor="baseUrl" className="text-xs font-medium tracking-wide text-ink-400 uppercase">
          Base URL
        </label>
        <input
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-sm outline-none focus:border-ember-600"
        />
        <p className="mt-1.5 text-xs text-ink-600">
          Any OpenAI-compatible endpoint works — change this to point at a proxy or gateway.
        </p>
      </div>

      <div className="mt-6">
        <label htmlFor="apiKey" className="text-xs font-medium tracking-wide text-ink-400 uppercase">
          API key
        </label>
        <input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={existing ? "Enter a new key to replace the saved one" : PROVIDERS[provider].keyHint}
          autoComplete="off"
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-sm outline-none placeholder:text-ink-600 focus:border-ember-600"
        />
      </div>

      <button
        type="submit"
        disabled={busy || !apiKey.trim()}
        className="mt-6 w-full rounded-lg bg-ink-100 px-4 py-2.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
      >
        {busy ? "Verifying key…" : existing ? "Replace key" : "Save key"}
      </button>

      {busy && (
        <p className="mt-3 text-center text-xs text-ink-500">
          Making one tiny test call to confirm it works.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3.5 py-2.5 text-xs leading-relaxed text-red-300">
          {error}
        </p>
      )}

      {saved && (
        <p className="mt-4 rounded-lg border border-ember-600/40 bg-ember-500/10 px-3.5 py-2.5 text-xs text-ember-300">
          Key verified and saved. Start a new chat from the sidebar.
        </p>
      )}
    </form>
  );
}
