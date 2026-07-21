"""Model catalogue and cost maths.

Mirrors lib/models.ts on the Next.js side. The TS copy drives the UI (settings
rate table, usage page); this copy drives what gets written to usage_events.
tests/test_pricing.py asserts the two agree.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    provider: str
    input_rate: float  # USD per 1M tokens
    output_rate: float
    cached_rate: float  # cache-read rate


MODELS = {
    m.id: m
    for m in [
        # Anthropic — cache reads are 0.1x base input across the Claude line.
        ModelSpec("claude-opus-4-8", "Claude Opus 4.8", "anthropic", 5, 25, 0.5),
        ModelSpec("claude-sonnet-5", "Claude Sonnet 5", "anthropic", 3, 15, 0.3),
        ModelSpec("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", 1, 5, 0.1),
        # OpenAI
        ModelSpec("gpt-5", "GPT-5", "openai", 1.25, 10, 0.125),
        ModelSpec("gpt-5-mini", "GPT-5 mini", "openai", 0.25, 2, 0.025),
        ModelSpec("gpt-4.1", "GPT-4.1", "openai", 2, 8, 0.5),
        # Moonshot
        ModelSpec("kimi-k2-0905-preview", "Kimi K2 (0905)", "moonshot", 0.6, 2.5, 0.15),
        ModelSpec("kimi-k2-turbo-preview", "Kimi K2 Turbo", "moonshot", 2.4, 10, 0.6),
        # Google — the 2.5 line, not 3.x (thought_signature; see lib/models.ts).
        # Gemini 2.5 Pro is tiered above a 200K prompt; these are the <=200K rates.
        ModelSpec("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini", 1.25, 10, 0.125),
        ModelSpec("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini", 0.3, 2.5, 0.03),
        ModelSpec("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", "gemini", 0.1, 0.4, 0.01),
    ]
}


def cost_of(model_id: str, input_tokens: int, output_tokens: int, cached_tokens: int) -> float:
    """Cost in USD.

    Every provider we support reports cached tokens as a *subset* of the prompt
    tokens, so they are billed at the cache-read rate and removed from the
    full-price input count. An unknown model returns 0 rather than raising, so a
    stale model id in an old chat can never break a turn.
    """
    spec = MODELS.get(model_id)
    if spec is None:
        return 0.0

    billed_input = max(0, input_tokens - cached_tokens)
    return (
        billed_input * spec.input_rate
        + cached_tokens * spec.cached_rate
        + output_tokens * spec.output_rate
    ) / 1_000_000
