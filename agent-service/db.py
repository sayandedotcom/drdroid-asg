"""Supabase access using the service-role key.

This service only ever runs behind the Next.js proxy, which has already
authenticated the user, so it uses the service role and passes user_id
explicitly. It never sees ENCRYPTION_SECRET — the model key arrives already
decrypted over the authenticated server-to-server call.
"""

from __future__ import annotations

import os
from typing import Any

from supabase import Client, create_client

_client: Client | None = None


def client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def record_usage(
    *,
    chat_id: str,
    user_id: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cached_tokens: int,
    cost_usd: float,
) -> None:
    client().table("usage_events").insert(
        {
            "chat_id": chat_id,
            "user_id": user_id,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": cached_tokens,
            "cost_usd": cost_usd,
        }
    ).execute()


def save_assistant_message(
    *, chat_id: str, user_id: str, content: str, steps: list[dict[str, Any]]
) -> None:
    client().table("messages").insert(
        {
            "chat_id": chat_id,
            "user_id": user_id,
            "role": "assistant",
            "content": content,
            "steps": steps,
        }
    ).execute()


# Signed URLs last a year: the download card stays on an old chat forever, and
# a link that 404s months later reads as a broken app.
REPORT_URL_TTL_SECONDS = 60 * 60 * 24 * 365


def upload_report(*, user_id: str, chat_id: str, title: str, pdf: bytes) -> str:
    """Uploads to the private `reports` bucket and returns a signed URL.

    The leading path segment is the owner's id, which is what the bucket's RLS
    policy checks.
    """
    import re
    import time

    slug = re.sub(r"[^a-z0-9]+", "-", title.lower())[:50].strip("-") or "report"
    path = f"{user_id}/{chat_id}/{int(time.time() * 1000)}-{slug}.pdf"

    storage = client().storage.from_("reports")
    storage.upload(
        path=path,
        file=pdf,
        file_options={"content-type": "application/pdf", "upsert": "true"},
    )
    signed = storage.create_signed_url(path, REPORT_URL_TTL_SECONDS)
    url = signed.get("signedURL")
    if not url:
        # Better to fail the turn (and refund) than to hand back a card that
        # downloads nothing.
        raise RuntimeError(f"could not sign a URL for {path}")
    return url


def save_artifact(*, chat_id: str, user_id: str, title: str, url: str) -> None:
    client().table("artifacts").insert(
        {"chat_id": chat_id, "user_id": user_id, "title": title, "url": url}
    ).execute()


def refund_credit(user_id: str) -> int | None:
    """Gives back the credit Next.js spent before calling us.

    Reuses the same grant_credits RPC the coupon and Stripe paths use.
    """
    result = client().rpc(
        "grant_credits",
        {"p_user": user_id, "p_amount": 1, "p_method": "refund", "p_event_id": None},
    ).execute()
    return result.data
