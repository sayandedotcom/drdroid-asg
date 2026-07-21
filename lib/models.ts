// Pricing is USD per 1,000,000 tokens.
//
// `cachedIn` is the rate for tokens served from the provider's prompt cache.
// Every provider we support reports cached tokens as a SUBSET of the prompt
// token count, so billed input = prompt - cached (see costOf below).

export type Provider = "anthropic" | "openai" | "moonshot" | "gemini";

export interface ModelSpec {
  id: string;
  label: string;
  provider: Provider;
  in: number;
  out: number;
  cachedIn: number;
  context: string;
}

export const PROVIDERS: Record<Provider, { label: string; baseUrl: string; keyHint: string }> = {
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1/",
    keyHint: "sk-ant-...",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    keyHint: "sk-...",
  },
  gemini: {
    label: "Google (Gemini)",
    // Gemini's OpenAI-compatibility layer, not the native generateContent API.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyHint: "AIza...",
  },
};

export const MODELS: ModelSpec[] = [
  // Anthropic — rates from platform.claude.com pricing.
  // Cache reads are 0.1x base input across the Claude line.
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic", in: 5, out: 25, cachedIn: 0.5, context: "1M" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", in: 3, out: 15, cachedIn: 0.3, context: "1M" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", in: 1, out: 5, cachedIn: 0.1, context: "200K" },

  // OpenAI
  { id: "gpt-5", label: "GPT-5", provider: "openai", in: 1.25, out: 10, cachedIn: 0.125, context: "400K" },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai", in: 0.25, out: 2, cachedIn: 0.025, context: "400K" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai", in: 2, out: 8, cachedIn: 0.5, context: "1M" },

  // Moonshot
  { id: "kimi-k2-0905-preview", label: "Kimi K2 (0905)", provider: "moonshot", in: 0.6, out: 2.5, cachedIn: 0.15, context: "256K" },
  { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo", provider: "moonshot", in: 2.4, out: 10, cachedIn: 0.6, context: "256K" },

  // Google — rates from ai.google.dev/gemini-api/docs/pricing (paid tier).
  //
  // Deliberately the 2.5 line, not 3.x. Gemini 3 models attach a
  // thought_signature to every function call and reject the next turn with a
  // 400 if it is not echoed back. Over the OpenAI-compatible endpoint that
  // signature rides in tool_calls[].extra_content, which langchain-openai drops
  // on the return trip -- so 3.x fails on the second agent step, every time,
  // with no parameter that avoids it. Moving to 3.x means moving this provider
  // off ChatOpenAI onto a Google-native client.
  //
  // Gemini 2.5 Pro is TIERED: above a 200K-token prompt the rates double to
  // $2.50 in / $15 out / $0.25 cached. ModelSpec carries one flat rate, so these
  // are the <=200K figures -- the common case for this app, where a turn is a
  // chat history plus research snippets. A user who pastes a genuinely huge
  // prompt is under-billed against Google's actual charge; adding tier support
  // to ModelSpec is the fix if that ever stops being an edge case.
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "gemini", in: 1.25, out: 10, cachedIn: 0.125, context: "1M" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini", in: 0.3, out: 2.5, cachedIn: 0.03, context: "1M" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", provider: "gemini", in: 0.1, out: 0.4, cachedIn: 0.01, context: "1M" },
];

export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelsFor(provider: Provider): ModelSpec[] {
  return MODELS.filter((m) => m.provider === provider);
}

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
}

/**
 * Cost in USD. Cached tokens are billed at the cache-read rate and removed
 * from the full-price input count, since providers report them as a subset of
 * the prompt tokens.
 */
export function costOf(modelId: string, u: TokenUsage): number {
  const spec = modelSpec(modelId);
  if (!spec) return 0;
  const billedInput = Math.max(0, u.input - u.cached);
  return (
    (billedInput * spec.in + u.cached * spec.cachedIn + u.output * spec.out) / 1_000_000
  );
}

export function fmtUSD(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}
