-- earlyrise: convenience view for Supabase UI (payments + telegram username)

create or replace view public.payments_with_user as
select
  p.*,
  u.telegram_user_id as user_telegram_user_id,
  u.username as user_username,
  u.first_name as user_first_name,
  case
    when u.username is not null and length(trim(u.username)) > 0 then '@' || u.username
    when u.telegram_user_id is not null then '#' || u.telegram_user_id::text
    else null
  end as user_display_name,
  c.title as challenge_title
from public.payments p
left join public.users u on u.id = p.user_id
left join public.challenges c on c.id = p.challenge_id;

