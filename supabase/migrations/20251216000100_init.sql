-- earlyrise: initial schema (MVP)
-- Notes:
-- - Uses pgcrypto for gen_random_uuid()
-- - Keeps RLS simple: admin UI should use service role key on server only.

create extension if not exists pgcrypto;

-- 1) users
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint unique not null,
  username text,
  first_name text,
  timezone text default 'Europe/Amsterdam',
  status text not null default 'active' check (status in ('active','paused','banned')),
  created_at timestamptz not null default now()
);

-- 2) challenges
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','active','closed')),
  rules_snapshot jsonb,
  created_at timestamptz not null default now()
);

-- 3) participations
create table if not exists public.participations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  role text not null default 'participant' check (role in ('participant','moderator')),
  unique (user_id, challenge_id)
);

-- 4) checkins
create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  checkin_at_utc timestamptz not null,
  source text not null check (source in ('text','voice','web')),
  status text not null default 'approved' check (status in ('pending','approved','rejected')),
  reject_reason text,
  raw_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_checkins_challenge_time on public.checkins (challenge_id, checkin_at_utc desc);
create index if not exists idx_checkins_user_time on public.checkins (user_id, checkin_at_utc desc);

-- 5) voice_transcripts
create table if not exists public.voice_transcripts (
  id uuid primary key default gen_random_uuid(),
  checkin_id uuid not null unique references public.checkins(id) on delete cascade,
  provider text not null default 'nhn',
  transcript text,
  confidence numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

-- 6) payments
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  provider text not null default 'manual' check (provider in ('stripe','telegram','manual')),
  amount numeric not null,
  currency text not null default 'EUR',
  status text not null default 'pending' check (status in ('pending','paid','refunded','failed')),
  provider_payment_id text,
  created_at timestamptz not null default now()
);

-- 7) wallet_ledger
create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  delta numeric not null,
  currency text not null default 'EUR',
  reason text,
  created_at timestamptz not null default now()
);

-- 8) settings (global + per-challenge)
create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'global' check (scope in ('global','challenge')),
  challenge_id uuid references public.challenges(id) on delete cascade,
  challenge_active boolean not null default true,
  voice_feedback_enabled boolean not null default true,
  checkin_window_minutes int not null default 30,
  pricing_mode text not null default 'credits',
  pricing_json jsonb,
  created_at timestamptz not null default now(),
  constraint settings_scope_challenge_consistency check (
    (scope = 'global' and challenge_id is null) or (scope = 'challenge' and challenge_id is not null)
  )
);

-- Admin allowlist (for web access)
create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

-- Simple view: user stats (streak is simplified for MVP)
create or replace view public.user_stats as
select
  u.id as user_id,
  u.telegram_user_id,
  u.username,
  u.first_name,
  u.timezone,
  (select count(*) from public.checkins c where c.user_id = u.id and c.status = 'approved') as total_checkins,
  (select max(c.checkin_at_utc) from public.checkins c where c.user_id = u.id and c.status = 'approved') as last_checkin_at_utc,
  -- MVP streak heuristic: consecutive days ending today/previous day in UTC.
  (
    with days as (
      select distinct date_trunc('day', c.checkin_at_utc)::date as d
      from public.checkins c
      where c.user_id = u.id and c.status = 'approved'
      order by d desc
    ),
    seq as (
      select d, row_number() over (order by d desc)::int as rn from days
    )
    select coalesce(count(*),0) from seq
    where d = (current_date - (rn - 1))
  ) as streak_days
from public.users u;

-- RLS (MVP): lock down everything for anon; server uses service role.
alter table public.users enable row level security;
alter table public.challenges enable row level security;
alter table public.participations enable row level security;
alter table public.checkins enable row level security;
alter table public.voice_transcripts enable row level security;
alter table public.payments enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.settings enable row level security;
alter table public.admins enable row level security;

-- Minimal policies (deny by default; allow authenticated users to read their own user row)
create policy "users_select_own" on public.users
  for select
  to authenticated
  using (false); -- For MVP we access users via server only; keep strict.






