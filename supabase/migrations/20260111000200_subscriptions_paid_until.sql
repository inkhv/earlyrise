-- earlyrise: subscriptions helpers (manual renewals)
-- Adds plan_code and computed access window fields.

alter table if exists public.payments
  add column if not exists plan_code text,
  add column if not exists order_id text,
  add column if not exists access_days int,
  add column if not exists access_until timestamptz,
  add column if not exists paid_at timestamptz;

create index if not exists idx_payments_user_challenge_status on public.payments (user_id, challenge_id, status);

alter table if exists public.users
  add column if not exists paid_until timestamptz,
  add column if not exists next_payment_reminder_at timestamptz,
  add column if not exists reminder_2d_sent_at timestamptz,
  add column if not exists last_renewal_prompt_at timestamptz,
  add column if not exists expiry_prompt_sent_at timestamptz,
  add column if not exists kicked_from_chat_at timestamptz;

create index if not exists idx_users_paid_until on public.users (paid_until);

