#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo bash deploy/scripts/reset-user-today.sh <telegram_user_id>
#
# What it does:
# - Finds active challenge
# - Computes user's LOCAL day window (based on users.timezone)
# - Deletes all checkins in that window (any source) for that challenge+user
# - Deletes linked anti_cheat_challenges + voice_transcripts for those checkin_ids
# - Verifies 0 remaining checkins in that local day window
# - Restarts earlyrise-bot to clear in-memory plusReminderSent

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <telegram_user_id>" >&2
  exit 2
fi

TGID="$1"
export TGID

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node --input-type=module - <<'NODE'
import process from "node:process";
import { supabaseAdmin } from "./apps/api/dist/config.js";
import { getActiveChallenge } from "./apps/api/dist/services/challenge.js";
import { utcRangeForLocalDay } from "./apps/api/dist/utils/time.js";

const telegramUserId = Number(process.env.TGID);
if (!Number.isFinite(telegramUserId) || telegramUserId <= 0) {
  console.error("bad telegram_user_id");
  process.exit(2);
}

const userRes = await supabaseAdmin
  .from("users")
  .select("id,timezone")
  .eq("telegram_user_id", telegramUserId)
  .maybeSingle();
if (!userRes.data) {
  console.error("user_not_found");
  process.exit(3);
}

const challenge = await getActiveChallenge();
if (!challenge) {
  console.error("no_active_challenge");
  process.exit(4);
}

const tz = userRes.data.timezone || "GMT+00:00";
const { startUtcIso, endUtcIso, localDate } = utcRangeForLocalDay({ now: new Date(), timeZone: tz });

// Collect checkins to delete (so we can also delete dependent tables).
const existing = await supabaseAdmin
  .from("checkins")
  .select("id,source")
  .eq("user_id", userRes.data.id)
  .eq("challenge_id", challenge.id)
  .gte("checkin_at_utc", startUtcIso)
  .lte("checkin_at_utc", endUtcIso);
if (existing.error) throw existing.error;
const ids = (existing.data || []).map((r) => r.id).filter(Boolean);

// Dependent cleanup (best-effort)
if (ids.length > 0) {
  const delAnti = await supabaseAdmin.from("anti_cheat_challenges").delete().in("checkin_id", ids).select("id");
  // voice_transcripts may not exist on older schema; ignore missing table.
  const delVT = await supabaseAdmin.from("voice_transcripts").delete().in("checkin_id", ids).select("checkin_id");

  // Delete checkins last.
  const delCheckins = await supabaseAdmin
    .from("checkins")
    .delete()
    .in("id", ids)
    .select("id,source");
  if (delCheckins.error) throw delCheckins.error;

  // Verify none left in the window.
  const remaining = await supabaseAdmin
    .from("checkins")
    .select("id")
    .eq("user_id", userRes.data.id)
    .eq("challenge_id", challenge.id)
    .gte("checkin_at_utc", startUtcIso)
    .lte("checkin_at_utc", endUtcIso);
  if (remaining.error) throw remaining.error;

  console.log(
    JSON.stringify({
      ok: true,
      telegram_user_id: telegramUserId,
      local_date: localDate,
      window_utc: { start: startUtcIso, end: endUtcIso },
      deleted: {
        checkins: delCheckins.data?.length ?? 0,
        checkin_sources: delCheckins.data?.map((r) => r.source) ?? [],
        anti_cheat_challenges: delAnti.error ? { error: true } : (delAnti.data?.length ?? 0),
        voice_transcripts: delVT.error ? { error: true } : (delVT.data?.length ?? 0)
      },
      remaining: remaining.data?.length ?? 0
    })
  );
} else {
  console.log(
    JSON.stringify({
      ok: true,
      telegram_user_id: telegramUserId,
      local_date: localDate,
      window_utc: { start: startUtcIso, end: endUtcIso },
      deleted: { checkins: 0, anti_cheat_challenges: 0, voice_transcripts: 0 },
      remaining: 0
    })
  );
}
NODE

sudo systemctl restart earlyrise-bot >/dev/null 2>&1 || systemctl restart earlyrise-bot
echo "bot_restarted=true"

