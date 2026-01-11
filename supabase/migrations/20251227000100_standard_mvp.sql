-- Standard MVP upgrades: wake modes + anti-cheat challenges for voice

-- 1) Wake mode per participation
alter table public.participations
  add column if not exists wake_mode text not null default 'fixed' check (wake_mode in ('fixed','flex'));

-- 2) Mark whether a check-in requires / passed anti-cheat (voice flow)
alter table public.checkins
  add column if not exists requires_anticheat boolean not null default false,
  add column if not exists anticheat_passed boolean not null default false;

create index if not exists idx_checkins_anticheat
  on public.checkins (challenge_id, user_id, requires_anticheat, anticheat_passed, checkin_at_utc desc);

-- 3) Anti-cheat challenges (simple arithmetic)
create table if not exists public.anti_cheat_challenges (
  id uuid primary key default gen_random_uuid(),
  checkin_id uuid not null unique references public.checkins(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  question text not null,
  answer_int int not null,
  attempts int not null default 0,
  status text not null default 'pending' check (status in ('pending','passed','failed','expired')),
  expires_at_utc timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_anticheat_pending
  on public.anti_cheat_challenges (challenge_id, status, expires_at_utc desc);

alter table public.anti_cheat_challenges enable row level security;

-- 4) Store generated curator reply alongside transcript (so we can return it after anti-cheat pass)
alter table public.voice_transcripts
  add column if not exists reply_text text;


