-- MicroManus schema. Safe to re-run.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  credits int not null default 0,
  unlocked boolean not null default false,
  unlock_method text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

-- Credits are only ever changed by the SECURITY DEFINER functions below,
-- so there is deliberately no client insert/update policy.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- llm_configs
-- No RLS policies at all: service-role access only. The encrypted key must
-- never be readable by the browser client.
create table if not exists public.llm_configs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null,
  base_url text not null,
  encrypted_api_key text not null,
  key_last4 text,
  default_model text not null,
  updated_at timestamptz not null default now()
);

alter table public.llm_configs enable row level security;

-- ------------------------------------------------------------------- chats
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  model text not null,
  created_at timestamptz not null default now()
);

alter table public.chats enable row level security;

drop policy if exists "own chats" on public.chats;
create policy "own chats" on public.chats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists chats_user_created_idx on public.chats (user_id, created_at desc);

-- ---------------------------------------------------------------- messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null default '',
  steps jsonb,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

drop policy if exists "own messages" on public.messages;
create policy "own messages" on public.messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists messages_chat_idx on public.messages (chat_id, created_at);

-- ------------------------------------------------------------ usage_events
-- One row per LLM API call, so a single user turn with a 5-step tool loop
-- produces 5 rows.
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cached_tokens int not null default 0,
  cost_usd numeric(12, 8) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

drop policy if exists "own usage" on public.usage_events;
create policy "own usage" on public.usage_events
  for select using (auth.uid() = user_id);

create index if not exists usage_chat_idx on public.usage_events (chat_id);

-- --------------------------------------------------------------- artifacts
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  url text not null,
  created_at timestamptz not null default now()
);

alter table public.artifacts enable row level security;

drop policy if exists "own artifacts" on public.artifacts;
create policy "own artifacts" on public.artifacts
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------- stripe idempotency
create table if not exists public.stripe_events (
  id text primary key,
  created_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;

-- ----------------------------------------------------------------- rpcs
-- Atomically consume one credit. Returns the remaining balance, or -1 if the
-- user had none.
create or replace function public.spend_credit(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  remaining int;
begin
  update public.profiles
     set credits = credits - 1
   where id = p_user and credits > 0
  returning credits into remaining;

  if remaining is null then
    return -1;
  end if;
  return remaining;
end;
$$;

-- Grant credits and unlock. Idempotent per p_event_id (used for the Stripe
-- session id); passing null skips the dedupe check.
create or replace function public.grant_credits(
  p_user uuid,
  p_amount int,
  p_method text,
  p_event_id text default null
)
returns int language plpgsql security definer set search_path = public as $$
declare
  total int;
begin
  if p_event_id is not null then
    begin
      insert into public.stripe_events (id) values (p_event_id);
    exception when unique_violation then
      -- Already processed this Stripe session; return the current balance.
      select credits into total from public.profiles where id = p_user;
      return coalesce(total, 0);
    end;
  end if;

  update public.profiles
     set credits = credits + p_amount,
         unlocked = true,
         unlock_method = coalesce(unlock_method, p_method)
   where id = p_user
  returning credits into total;

  return coalesce(total, 0);
end;
$$;

revoke all on function public.grant_credits(uuid, int, text, text) from public, anon, authenticated;
revoke all on function public.spend_credit(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------- storage
insert into storage.buckets (id, name, public)
values ('reports', 'reports', true)
on conflict (id) do update set public = true;

drop policy if exists "public read reports" on storage.objects;
create policy "public read reports" on storage.objects
  for select using (bucket_id = 'reports');
