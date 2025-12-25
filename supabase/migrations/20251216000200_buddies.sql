-- Buddy pairing / partner mechanics (MVP schema)
--
-- Requirements:
-- - Users can request a buddy.
-- - Primary match: same timezone AND same wake_time_local.
-- - Fallback match: different timezone but same wake "instant" (approx) via wake_utc_minutes.
-- - If one buddy leaves/disqualifies, both leave/disqualify (enforced in API logic).
-- - Admin can assign buddies manually.

-- Store chosen wake time per participation (per challenge).
alter table public.participations
  add column if not exists wake_time_local time,
  add column if not exists wake_utc_minutes int;

comment on column public.participations.wake_time_local is 'User-chosen wake time in their local timezone (per challenge)';
comment on column public.participations.wake_utc_minutes is 'Wake time as minutes since 00:00 UTC for matching across timezones (computed in API)';

create index if not exists idx_participations_wake_match
  on public.participations (challenge_id, wake_time_local, wake_utc_minutes)
  where left_at is null;

-- Active buddy pair for a challenge.
create table if not exists public.buddy_pairs (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  participation_a_id uuid not null references public.participations(id) on delete cascade,
  participation_b_id uuid not null references public.participations(id) on delete cascade,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  constraint buddy_pairs_distinct_participants check (participation_a_id <> participation_b_id)
);

-- Ensure a participation is in at most one ACTIVE pair.
create unique index if not exists uq_buddy_pairs_a_active
  on public.buddy_pairs (participation_a_id)
  where status = 'active';

create unique index if not exists uq_buddy_pairs_b_active
  on public.buddy_pairs (participation_b_id)
  where status = 'active';

create index if not exists idx_buddy_pairs_challenge
  on public.buddy_pairs (challenge_id, status);

-- Waiting list entry when no buddy found.
create table if not exists public.buddy_waitlist (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  participation_id uuid not null unique references public.participations(id) on delete cascade,
  desired_timezone text not null,
  desired_wake_time_local time not null,
  desired_wake_utc_minutes int,
  created_at timestamptz not null default now()
);

create index if not exists idx_buddy_waitlist_match
  on public.buddy_waitlist (challenge_id, desired_timezone, desired_wake_time_local, desired_wake_utc_minutes);

-- RLS (keep locked down for MVP; access via server using service role)
alter table public.buddy_pairs enable row level security;
alter table public.buddy_waitlist enable row level security;






