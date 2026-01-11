-- Add last_seen_at to support "trial offer after inactivity"
alter table if exists public.users
  add column if not exists last_seen_at timestamptz not null default now();

