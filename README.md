# MicroManus

A deep research agent with usage-based billing. Sign in with GitHub, unlock with a coupon or $5,
add your own model API key, then ask questions the agent answers by searching the live web in a
think → search → read → think again loop. It can hand back a formatted PDF report.

Built with Next.js 16 (App Router), Supabase (auth + Postgres + storage), Stripe, and Tavily.

---

## What it does

- **GitHub social login** via Supabase Auth. No passwords.
- **Paywall** — bypassed with coupon `SID_DRDROID`, or by paying $5 through Stripe Checkout.
  Either path grants 5 credits.
- **Bring your own key** — no model key ships with the app. Users add an OpenAI-compatible key
  and base URL; the key is verified with a live test call, then AES-256-GCM encrypted at rest.
- **Agentic loop** — up to 10 iterations of tool calling. The UI streams each step (searching,
  reading sources, writing the PDF) as it happens.
- **PDF artifacts** — the agent calls `create_pdf_report` when a deliverable is wanted. Reports
  render headings, lists, links, blockquotes, and tables, and upload to Supabase Storage.
- **Conversation threads** — separate chats, each holding its own context and model.
- **Cost tracking** — one row per model call, split by input / output / cached tokens, priced at
  the real rates for the model that chat uses.

### Credits

One credit per user message, regardless of how many tool steps it triggers. If a turn fails
outright, the credit is refunded automatically.

---

## Setup

You need free accounts for Supabase, Stripe (test mode), Tavily, and Vercel.

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the whole of [`supabase/migration.sql`](supabase/migration.sql),
   and run it. It is idempotent — safe to re-run.
3. **Authentication → Providers → GitHub**: enable it. You need a GitHub OAuth app
   ([github.com/settings/developers](https://github.com/settings/developers)) with its callback
   URL set to the value Supabase shows on that screen
   (`https://YOUR_PROJECT.supabase.co/auth/v1/callback`). Paste the Client ID and Secret back
   into Supabase.
4. **Authentication → URL Configuration**: set **Site URL** to your deployed URL, and add
   `https://YOUR_APP/auth/callback` under Redirect URLs. Add
   `http://localhost:3000/auth/callback` too if you want local development to work.
5. From **Project Settings → API**, copy the Project URL, the `anon` key, and the
   `service_role` key.

### 2. Stripe (test mode)

1. In the Stripe dashboard, make sure you are in **Test mode**.
2. Copy the secret key (`sk_test_…`).
3. **Developers → Webhooks → Add endpoint**: point it at `https://YOUR_APP/api/stripe/webhook`
   and subscribe to `checkout.session.completed`. Copy the signing secret (`whsec_…`).

The app does not depend on the webhook alone — when Stripe redirects the user back, the app also
verifies the session server-side and grants credits. Both paths share the Stripe session id as an
idempotency key, so credits are never granted twice.

### 3. Tavily

Get a free API key at [tavily.com](https://tavily.com). This powers the agent's web search and is
the one server-side key the app owns.

### 4. Environment

Copy `.env.example` to `.env.local` and fill it in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
TAVILY_API_KEY=
ENCRYPTION_SECRET=      # openssl rand -base64 32
COUPON_CODE=SID_DRDROID
NEXT_PUBLIC_APP_URL=    # no trailing slash
```

`ENCRYPTION_SECRET` encrypts users' API keys. Changing it makes existing saved keys unreadable —
users would need to re-enter them.

### 5. Run

```bash
npm install
npm run dev
```

### 6. Deploy

```bash
vercel --prod
```

Add every variable above in the Vercel project settings, setting `NEXT_PUBLIC_APP_URL` to the
production URL. Then go back and update the Supabase Site URL / redirect URLs and the Stripe
webhook endpoint to match that domain.

---

## Testing the full flow

1. Sign in with GitHub.
2. On the paywall, either enter `SID_DRDROID`, or pay with Stripe test card `4242 4242 4242 4242`
   (any future expiry, any CVC, any postcode). Both give 5 credits.
3. In Settings, pick a provider, choose a model, and paste your API key. The app makes one small
   test call before saving, so a bad key fails immediately rather than mid-conversation.
4. Start a chat and ask something that needs research, e.g. *"Create a report explaining the
   recent forest fires in California, what is causing them and what can be done to avoid them."*
   Watch the step timeline; a PDF card appears when the report is ready.
5. Ask a follow-up in the same chat to confirm it holds context.
6. Open **Usage & cost** to see per-chat token and cost breakdown.

---

## How cost is calculated

Rates live in [`lib/models.ts`](lib/models.ts) as USD per million tokens, with a separate
cache-read rate per model.

Every provider we support reports cached tokens as a *subset* of the prompt tokens, so:

```
cost = (input − cached) × inputRate
     + cached          × cachedRate
     + output          × outputRate
```

Cached-token counts are read from `prompt_tokens_details.cached_tokens`, falling back to
`cached_tokens` and `cache_read_input_tokens` for providers that report them differently. A
provider that reports none is treated as zero rather than failing.

The system prompt is kept byte-stable as the conversation prefix so provider-side automatic
prompt caching can hit on repeated turns.

---

## Security notes

- Model API keys are AES-256-GCM encrypted before storage. `llm_configs` has row level security
  enabled with **no client policies at all** — only server routes using the service role can read
  it, so the browser can never fetch a key.
- Every other table is protected by RLS scoped to `auth.uid()`.
- Credit changes only happen inside `SECURITY DEFINER` functions (`spend_credit`,
  `grant_credits`); there is no client-side update path to the credits column.
- The coupon check is a constant-time hash comparison.
- Stripe webhooks are signature-verified against the raw request body.
