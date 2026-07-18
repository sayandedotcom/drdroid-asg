"""Guards the Python cost maths against the TypeScript source of truth.

lib/models.ts drives the UI (settings rate table, usage page); pricing.py drives
what gets written to usage_events. If they drift, the numbers a reviewer sees
stop matching what was billed.
"""

import re
from pathlib import Path

import pytest

from pricing import MODELS, cost_of

MODELS_TS = Path(__file__).resolve().parents[2] / "lib" / "models.ts"


def _parse_ts_rates() -> dict[str, tuple[float, float, float]]:
    """Pulls { id: (in, out, cachedIn) } out of the MODELS array in models.ts."""
    source = MODELS_TS.read_text()
    pattern = re.compile(
        r'\{\s*id:\s*"(?P<id>[^"]+)".*?'
        r"\bin:\s*(?P<in>[\d.]+),\s*"
        r"out:\s*(?P<out>[\d.]+),\s*"
        r"cachedIn:\s*(?P<cached>[\d.]+)",
        re.S,
    )
    return {
        m.group("id"): (float(m.group("in")), float(m.group("out")), float(m.group("cached")))
        for m in pattern.finditer(source)
    }


def test_ts_file_is_parseable():
    assert MODELS_TS.exists(), f"expected {MODELS_TS} to exist"
    assert _parse_ts_rates(), "parsed no models out of models.ts — the regex needs updating"


def test_rates_match_typescript():
    ts = _parse_ts_rates()

    assert set(ts) == set(MODELS), (
        "model ids differ between lib/models.ts and pricing.py: "
        f"only in TS={set(ts) - set(MODELS)}, only in Python={set(MODELS) - set(ts)}"
    )

    for model_id, (in_rate, out_rate, cached_rate) in ts.items():
        spec = MODELS[model_id]
        assert spec.input_rate == in_rate, f"{model_id} input rate"
        assert spec.output_rate == out_rate, f"{model_id} output rate"
        assert spec.cached_rate == cached_rate, f"{model_id} cached rate"


def test_cached_tokens_are_billed_as_a_subset_of_input():
    # 20k prompt tokens of which 15k came from cache, 3k output, on Sonnet 5:
    #   5,000 * $3/1M  +  15,000 * $0.30/1M  +  3,000 * $15/1M
    #   = 0.015 + 0.0045 + 0.045
    assert cost_of("claude-sonnet-5", 20_000, 3_000, 15_000) == pytest.approx(0.0645)


def test_zero_cache_path():
    # 10,000 * $5/1M + 2,000 * $25/1M
    assert cost_of("claude-opus-4-8", 10_000, 2_000, 0) == pytest.approx(0.10)


def test_caching_is_never_more_expensive():
    uncached = cost_of("gpt-5", 10_000, 1_000, 0)
    cached = cost_of("gpt-5", 10_000, 1_000, 8_000)
    assert cached < uncached


def test_unknown_model_returns_zero_instead_of_raising():
    # A stale model id in an old chat must not be able to break a turn.
    assert cost_of("some-retired-model", 1_000, 1_000, 0) == 0.0
