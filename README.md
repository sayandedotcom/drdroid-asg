# MicroManus

A deep research agent with usage-based billing. Sign in with GitHub, unlock with a coupon or $5,
add your own model API key, then ask questions the agent answers by searching the live web in a
think → search → read → think again loop. It can hand back a formatted PDF report.

**Python + TypeScript.** A Next.js 16 frontend and control plane, and a Python **FastAPI +
LangGraph** service that runs the agent. Web search is consumed over **MCP** (Tavily's remote MCP
server) with a REST fallback. Storage, auth and billing are Supabase and Stripe.

---

## Architecture

```
Browser ── SSE ──> Next.js /api/chat            (Vercel project 1)
                     auth · chat ownership · spend credit
                     decrypt the user's model key · persist the user message
                        │
                        │  POST /run  + Bearer AGENT_SERVICE_SECRET
                        │  streams SSE straight back, unmodified
                        ▼
                   FastAPI /run                  (Vercel project 2, ./agent-service)
                     LangGraph StateGraph:  agent ⇄ tools,  ≤10 model calls
                     ├─ web_search      → Tavily MCP, falling back to Tavily REST
                     ├─ create_pdf_report → fpdf2 → Supabase Storage
                     └─ per model call: usage_events row, priced for that model
```

Two deployments, one repo. The Python service is never exposed to the browser — Next.js proxies
to it — so there is no CORS surface and a shared secret is sufficient authentication.

**Why the split.** The agent loop is the part that benefits from LangGraph: an explicit
`StateGraph` with a conditional edge makes the think→act→observe cycle, its termination condition
and its per-step instrumentation legible, rather than burying them in a hand-rolled `while` loop.
Everything that is *not* the agent — auth, paywall, credits, key management — stays in Next.js
where it already works.

**Why an explicit graph rather than a prebuilt ReAct agent.** Usage has to be recorded after every
individual model call, because one user turn with a five-step research loop must produce five
costed rows. The `agent` node writes a `usage_events` row on each pass.

### Responsibility split

| | Next.js | Agent service |
|---|---|---|
| Auth, ownership, paywall | ✅ | — |
| Spend a credit | ✅ (before calling) | — |
| Refund on failure | only if the service is unreachable | ✅ |
| Decrypt the model key | ✅ (`ENCRYPTION_SECRET` never leaves Next) | receives it decrypted |
| Persist user message / chat title | ✅ | — |
| Agent loop, tools, usage rows, assistant message, artifacts | — | ✅ |

---

## What it does

- **GitHub social login** via Supabase Auth. No passwords.
- **Paywall** — bypassed with coupon `SID_DRDROID`, or by paying $5 through Stripe Checkout.
  Either path grants 5 credits.
- **Bring your own key** — no model key ships with the app. Users add an OpenAI-compatible key
  and base URL; the key is verified with a live test call, then AES-256-GCM encrypted at rest.
  Anthropic, OpenAI and Moonshot presets are built in; any compatible endpoint works.
- **Agentic loop** — up to 10 model calls per turn. The UI streams each step as it happens
  (thinking, searching, reading N sources, writing the PDF).
- **MCP** — the search tool is loaded from Tavily's remote MCP server at startup via
  `langchain-mcp-adapters`. If that connection is unavailable the tool falls back to Tavily's REST
  API, so a flaky MCP server degrades a run instead of breaking it. The step label records which
  transport served the results.
- **PDF artifacts** — headings, lists, links, tables, blockquotes and code. Unicode-safe (DejaVu
  is bundled; the built-in PDF fonts are Latin-1 only and would fail on accented names).
- **Conversation threads** — separate chats, each holding its own context and model.
- **Cost tracking** — one row per model call, split by input / output / cached tokens, priced at
  the real rates for the model that chat uses.

### Credits

One credit per user message, regardless of how many tool steps it triggers. If a turn fails
outright the credit is refunded automatically.

---

## Setup

You need free accounts for Supabase, Stripe (test mode), Tavily, and Vercel.

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the whole of [`supabase/migration.sql`](supabase/migration.sql),
   and run it. It is idempotent — safe to re-run.
3. **Authentication → Providers → GitHub**: enable it. You need a GitHub OAuth app
   ([github.com/settings/developers](https://github.com/settings/developers)) with its callback
   URL set to the value Supabase shows (`https://YOUR_PROJECT.supabase.co/auth/v1/callback`).
4. **Authentication → URL Configuration**: set **Site URL** to your deployed URL, and add
   `https://YOUR_APP/auth/callback` (plus `http://localhost:3000/auth/callback` for local work).
5. From **Project Settings → API**, copy the Project URL, the `anon` key and the `service_role`
   key.

### 2. Stripe (test mode)

1. Confirm the dashboard is in **Test mode**, then copy the secret key (`sk_test_…`).
2. **Developers → Webhooks → Add endpoint**: point it at `https://YOUR_APP/api/stripe/webhook`,
   subscribe to `checkout.session.completed`, copy the signing secret (`whsec_…`).

The app does not depend on the webhook alone — when Stripe redirects the user back, it also
verifies the session server-side. Both paths share the Stripe session id as an idempotency key,
so credits are never granted twice.

### 3. Tavily

Get a free API key at [tavily.com](https://tavily.com). It serves both the MCP connection and the
REST fallback, and belongs to the **agent service** project only.

### 4. Environment

Copy `.env.example` to `.env.local` and fill it in. Note that the two projects take different
variable sets — the file documents both.

`ENCRYPTION_SECRET` encrypts users' model keys; rotating it invalidates every saved key.
`AGENT_SERVICE_SECRET` must be identical on both projects.

### 5. Run locally

Two processes:

```bash
# terminal 1 — agent service
cd agent-service
uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
AGENT_SERVICE_SECRET=dev SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… TAVILY_API_KEY=… \
  .venv/bin/python -m uvicorn main:app --port 8000

# terminal 2 — web app
npm install && npm run dev
```

With `AGENT_SERVICE_URL=http://localhost:8000` in `.env.local`.

### 6. Deploy

Two Vercel projects from the same repository:

| Project | Root Directory | Framework |
|---|---|---|
| `micromanus` | `./` | Next.js |
| `micromanus-agent` | `agent-service` | Other (Python auto-detected) |

Deploy the agent service first, then set `AGENT_SERVICE_URL` on the web project to its URL. Then
update the Supabase Site URL / redirect URLs and the Stripe webhook endpoint to the web project's
domain.

---

## Tests

```bash
cd agent-service && .venv/bin/python -m pytest -q
```

The suite runs with **no live LLM key**. A scripted chat model replays a full research turn —
search, then PDF, then answer — and the tests assert the SSE event sequence, that one
`usage_events` row is written per model call, that cached tokens are priced at the cache-read
rate, that the loop terminates at its step limit, that a provider failure refunds the credit, and
that a broken MCP connection falls back to REST without breaking the run.

`test_pricing.py` parses `lib/models.ts` and asserts the Python rate table matches it, so the
numbers a reviewer sees on the usage page cannot silently drift from what was billed.

---

## Testing the full flow manually

1. Sign in with GitHub.
2. On the paywall, enter `SID_DRDROID`, or pay with Stripe test card `4242 4242 4242 4242` (any
   future expiry, any CVC). Both give 5 credits.
3. In Settings, pick a provider and model and paste your API key. The app makes one small test
   call before saving, so a bad key fails immediately rather than mid-conversation.
4. Ask something that needs research, e.g. *"Create a report explaining the recent forest fires in
   California, what is causing them and what can be done to avoid them."* Watch the step timeline;
   a PDF card appears when the report is ready.
5. Ask a follow-up in the same chat to confirm it holds context.
6. Open **Usage & cost** for the per-chat token and cost breakdown.

---

## How cost is calculated

Rates live in [`lib/models.ts`](lib/models.ts) (UI) and [`agent-service/pricing.py`](agent-service/pricing.py)
(what gets billed), kept in step by a test.

Every provider we support reports cached tokens as a *subset* of the prompt tokens, so:

```
cost = (input − cached) × inputRate
     + cached          × cachedRate
     + output          × outputRate
```

Cached counts are read from `usage_metadata.input_token_details.cache_read`, falling back to the
raw provider payload (`prompt_tokens_details.cached_tokens`, `cache_read_input_tokens`). A
provider that reports none is treated as zero rather than failing.

The system prompt is byte-stable across turns so provider-side automatic prompt caching can hit —
that is what makes the cached-token column non-zero on later messages in a chat.

---

## Security notes

- Model API keys are AES-256-GCM encrypted before storage. `llm_configs` has RLS enabled with
  **no client policies at all** — only the service role can read it, so the browser can never
  fetch a key.
- The agent service is not publicly usable: every request needs `AGENT_SERVICE_SECRET`, and it is
  only ever called server-to-server.
- Every other table is protected by RLS scoped to `auth.uid()`.
- Credit changes happen only inside `SECURITY DEFINER` functions (`spend_credit`,
  `grant_credits`); there is no client-side write path to the credits column.
- The coupon check is a constant-time hash comparison.
- Stripe webhooks are signature-verified against the raw request body.
