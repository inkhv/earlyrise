import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { env, supabaseAdmin } from "../config.js";
import { postJson } from "../services/n8n.js";
import { generateAntiCheat } from "../services/antiCheat.js";
import { maybeStoreVoiceAudio } from "../services/storage.js";
import { getActiveChallenge, type AccessStatus, isAllowedWakeTime } from "../services/challenge.js";
import {
  fmtHHMM,
  getLocalParts,
  isInWindow,
  minutesOfDay,
  normalizeTimezoneToStore,
  parseGmtOffsetToMinutes,
  parseTimeHHMM,
  utcRangeForLocalDay
} from "../utils/time.js";

const CURATOR_SYSTEM_PROMPT = [
  "You are an early-wake curator and a supportive habit coach.",
  "The user sends ONE voice report (as a transcript). There is no back-and-forth conversation. You respond ONCE.",
  "",
  "Language rule:",
  "- Always reply in Russian.",
  "",
  "Your goal is to support and reinforce the habit without judgment or moralizing:",
  "- Notice and praise any helpful action (even small).",
  "- Do not judge or grade (no “good/bad”), no shame, no pressure, no lecturing.",
  "- If the user is struggling, acknowledge difficulty and encourage them calmly.",
  "- Remind the main goal: “80% early wake-ups over all time” (consistency over perfection).",
  "",
  "Special case: if the user overslept / slipped:",
  "- Say it’s not a big deal.",
  "- Reduce guilt and tension.",
  "- Emphasize that habits are built by long-term statistics, not perfect days.",
  "- Say they will succeed if they keep paying attention to early wake-ups.",
  "",
  "Response format rules:",
  "- 5–10 short sentences.",
  "- Internal flow (no headings): reflection -> praise -> encouragement/normalization -> reminder about the 80% goal.",
  "- Do NOT ask any questions.",
  "- No links, no selling/services.",
  "- No action instructions (no “do X tomorrow”), no micro-steps, no plans or checklists.",
  "- Avoid strict wording (Russian equivalents such as «должен», «надо», «нужно», «обязан»)."
].join("\n");


function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function tbankToken(payload: Record<string, any>, password: string): string {
  // Tinkoff/T-Bank token algorithm: sort keys, concatenate values + Password, sha256.
  const p: Record<string, any> = { ...payload };
  delete p.Token;
  delete p.token;
  p.Password = password;
  const keys = Object.keys(p).sort();
  // Note: some fields (e.g. DATA) can be objects. The provider expects scalar values in token calculation.
  // To avoid "[object Object]" issues, treat non-null objects as empty string.
  const concat = keys
    .map((k) => {
      const v = p[k];
      if (v === undefined || v === null) return "";
      if (typeof v === "object") return "";
      return String(v);
    })
    .join("");
  return sha256Hex(concat);
}

function tbankOrderId(parts: Array<string | number>): string {
  // T-Bank requirement: OrderId length must be 1..50
  const raw = parts
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join("_");
  const safe = raw.replace(/[^\w.-]/g, "_");
  return safe.length <= 50 ? safe : safe.slice(0, 50);
}

async function openaiTranscribe(params: {
  apiKey: string;
  model: string;
  audioBytes: Uint8Array;
  mime: string;
}): Promise<{ transcript: string; raw: any }> {
  const { apiKey, model, audioBytes, mime } = params;
  const form = new FormData();
  const blob = new Blob([audioBytes], { type: mime || "audio/ogg" });
  // @ts-ignore - Node's File may not be typed, Blob works for fetch FormData
  form.append("file", blob, "voice.ogg");
  form.append("model", model);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`openai transcribe failed: ${res.status} ${res.statusText} ${text}`);
  }
  const transcript = (json?.text || json?.transcript || "").toString();
  return { transcript, raw: json };
}

async function openaiCuratorReply(params: {
  apiKey: string;
  model: string;
  system: string;
  transcript: string;
  localeNow?: string;
  language?: string;
  timezone?: string;
}): Promise<{ reply: string; raw: any }> {
  const { apiKey, model, system, transcript, language, timezone } = params;

  // Preferred: use Prompt Builder ID if configured
  if (env.OPENAI_PROMPT_ID) {
    const payload = {
      prompt: {
        id: env.OPENAI_PROMPT_ID,
        version: env.OPENAI_PROMPT_VERSION || "1",
        variables: {
          transcript: transcript || "",
          language: language || "",
          timezone: timezone || ""
        }
      }
    };

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`openai responses failed: ${res.status} ${res.statusText} ${text}`);
    }
    const reply = (json?.output_text || json?.output?.[0]?.content?.[0]?.text || "").toString().trim();
    return { reply: reply || fallbackCuratorReply(transcript || null), raw: json };
  }

  // Fallback: classic chat.completions with inline system prompt
  const user = transcript?.trim()
    ? `Вот расшифровка голосового отчёта участника:\n\n${transcript}\n\nСгенерируй ответ куратора по правилам.`
    : "Участник отправил голосовое, но расшифровки нет. Сгенерируй мягкий ответ куратора и попроси в следующий раз чуть больше конкретики.";

  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.6
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`openai chat failed: ${res.status} ${res.statusText} ${text}`);
  }
  const reply = (json?.choices?.[0]?.message?.content || "").toString().trim();
  return { reply: reply || fallbackCuratorReply(transcript || null), raw: json };
}

function fallbackCuratorReply(transcript: string | null): string {
  const hasContent = !!(transcript && transcript.trim().length > 0);
  if (!hasContent) {
    return [
      "Принял твоё голосовое — спасибо, что отметил чек-ин.",
      "Даже сам факт фиксации — полезное действие и вклад в привычку.",
      "Если сейчас тяжело, это нормально: устойчивость строится не идеальными днями, а возвращением к ритму.",
      "Наша цель — 80% ранних подъёмов за всё время, без давления и без перфекционизма."
    ].join(" ");
  }
  return [
    "Принял твой отчёт — спасибо, что проговорил, как прошло утро.",
    "Вижу полезные действия и внимание к процессу — это укрепляет привычку.",
    "Если было сложно, это ок: такие дни не отменяют прогресс, они часть пути.",
    "Двигаемся к 80% ранних подъёмов за всё время — спокойно и стабильно."
  ].join(" ");
}

function fmtWakeHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseWakeMode(inputRaw: string): { wake_mode: "fixed"; wake_time_hhmm: string } | { wake_mode: "flex" } | null {
  const s = String(inputRaw || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (
    lower === "flex" ||
    lower === "any" ||
    lower === "без" ||
    lower === "безвремени" ||
    lower.includes("без точ") ||
    lower.includes("без времени") ||
    lower.includes("просто просып") ||
    lower.includes("без времени подъема")
  ) {
    return { wake_mode: "flex" };
  }
  const parsed = parseTimeHHMM(s);
  if (!parsed) return null;
  const hhmm = fmtWakeHHMM(parsed.hour, parsed.minute);
  if (!isAllowedWakeTime(hhmm)) return null;
  return { wake_mode: "fixed", wake_time_hhmm: hhmm };
}

function localDateString(now: Date, timeZone: string): string {
  const p = getLocalParts(now, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function inMinutesRangeCircular(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  // Inclusive range on a circular 0..1439 clock.
  // If start <= end: [start..end]
  // Else: wraps midnight: [start..1439] U [0..end]
  if (startMinutes <= endMinutes) return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

async function hasVoiceCheckinForLocalDay(params: { user_id: string; challenge_id: string; timeZone: string; now: Date }): Promise<boolean> {
  const { startUtcIso, endUtcIso } = utcRangeForLocalDay({ now: params.now, timeZone: params.timeZone });
  const existing = await supabaseAdmin
    .from("checkins")
    .select("id")
    .eq("user_id", params.user_id)
    .eq("challenge_id", params.challenge_id)
    .eq("source", "voice")
    .in("status", ["pending", "approved"] as any)
    .gte("checkin_at_utc", startUtcIso)
    .lte("checkin_at_utc", endUtcIso)
    .limit(1);
  if (existing.error) throw existing.error;
  return (existing.data || []).length > 0;
}

function isFutureIso(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > Date.now();
}

function isMissingColumnError(e: any, column: string): boolean {
  const msg = String(e?.message || e?.details || e || "");
  const m = msg.toLowerCase();
  // Postgres: column "x" does not exist
  if (/column .* does not exist/i.test(msg) && m.includes(column.toLowerCase())) return true;
  // PostgREST schema cache: Could not find the 'x' column of 'table' in the schema cache
  if (m.includes("schema cache") && m.includes(column.toLowerCase())) return true;
  return false;
}

function isSchemaColumnIssue(e: any): boolean {
  const msg = String(e?.message || e?.details || e || "");
  return /column .* does not exist/i.test(msg) || /schema cache/i.test(msg) || /could not find the '.+' column/i.test(msg);
}

async function touchUserLastSeen(userId: string): Promise<void> {
  try {
    const upd = await supabaseAdmin.from("users").update({ last_seen_at: new Date().toISOString() } as any).eq("id", userId);
    if (upd.error) {
      if (isMissingColumnError(upd.error, "last_seen_at")) return;
      throw upd.error;
    }
  } catch (e: any) {
    if (isMissingColumnError(e, "last_seen_at")) return;
    // non-critical; ignore
  }
}

function fmtDateRu(date: Date): string {
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря"
  ];
  const d = date.getUTCDate();
  const m = months[date.getUTCMonth()] || "";
  const y = date.getUTCFullYear();
  return `${d} ${m} ${y} года`;
}

function paidDaysFromPlanOrAmount(plan_code: any, amountRub: any): { days: number | null; is_forever: boolean } {
  const code = String(plan_code || "").trim().toLowerCase();
  if (code === "life" || code === "forever" || code === "support") return { days: null, is_forever: true };
  if (code === "d30" || code === "30" || code === "30d") return { days: 30, is_forever: false };
  if (code === "d60" || code === "60" || code === "60d") return { days: 60, is_forever: false };
  if (code === "d90" || code === "90" || code === "90d") return { days: 90, is_forever: false };

  const a = Number(amountRub);
  // Backward-compat + safety by price
  if (a === 3000) return { days: null, is_forever: true };
  if (a === 490) return { days: 30, is_forever: false };
  if (a === 890) return { days: 60, is_forever: false };
  if (a === 990) return { days: 60, is_forever: false };
  if (a === 1400) return { days: 90, is_forever: false };
  if (a === 1490) return { days: 90, is_forever: false };
  return { days: null, is_forever: false };
}

async function getPaidAccessInfo(params: {
  user_id: string;
  challenge_id: string;
}): Promise<{ is_active_paid: boolean; has_any_paid: boolean; is_forever: boolean; paid_until_utc: string | null }> {
  const { user_id, challenge_id } = params;
  let res: any = await supabaseAdmin
    .from("payments")
    .select("created_at, plan_code, amount")
    .eq("user_id", user_id)
    .eq("challenge_id", challenge_id)
    .eq("status", "paid");
  if (res.error && isMissingColumnError(res.error, "plan_code")) {
    // Backward compatibility for DB schemas without payments.plan_code
    res = await supabaseAdmin
      .from("payments")
      .select("created_at, amount")
      .eq("user_id", user_id)
      .eq("challenge_id", challenge_id)
      .eq("status", "paid");
  }
  if (res.error) throw res.error;
  const rows = (res.data || []) as any[];
  const has_any_paid = rows.length > 0;
  if (!has_any_paid) return { is_active_paid: false, has_any_paid: false, is_forever: false, paid_until_utc: null };

  let is_forever = false;
  let maxUntil: Date | null = null;
  for (const r of rows as any[]) {
    const info = paidDaysFromPlanOrAmount((r as any).plan_code, (r as any).amount);
    if (info.is_forever) {
      is_forever = true;
      continue;
    }
    if (info.days && (r as any).created_at) {
      const start = new Date(String((r as any).created_at));
      const until = new Date(start.getTime() + info.days * 86400000);
      if (!maxUntil || until.getTime() > maxUntil.getTime()) maxUntil = until;
    }
  }
  if (is_forever) return { is_active_paid: true, has_any_paid: true, is_forever: true, paid_until_utc: null };
  const paid_until_utc = maxUntil ? maxUntil.toISOString() : null;
  const is_active_paid = paid_until_utc ? isFutureIso(paid_until_utc) : false;
  return { is_active_paid, has_any_paid: true, is_forever: false, paid_until_utc };
}

async function getLatestPayment(params: { user_id: string; challenge_id: string }): Promise<{ status: string; provider_payment_id: string | null; created_at: string } | null> {
  const res = await supabaseAdmin
    .from("payments")
    .select("status, provider_payment_id, created_at")
    .eq("user_id", params.user_id)
    .eq("challenge_id", params.challenge_id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (res.error) throw res.error;
  const row: any = res.data?.[0];
  if (!row) return null;
  return { status: String(row.status || ""), provider_payment_id: row.provider_payment_id ? String(row.provider_payment_id) : null, created_at: String(row.created_at || "") };
}

async function getTrialUntilUtc(user_id: string, challenge_id: string): Promise<string | null> {
  const res = await supabaseAdmin
    .from("wallet_ledger")
    .select("created_at")
    .eq("user_id", user_id)
    .eq("challenge_id", challenge_id)
    .eq("reason", "trial_7d_start")
    .order("created_at", { ascending: false })
    .limit(1);
  if (res.error) throw res.error;
  const row: any = res.data?.[0];
  if (!row?.created_at) return null;
  const start = new Date(row.created_at);
  const until = new Date(start.getTime() + 7 * 86400000);
  return until.toISOString();
}

async function ensureRefundNoticeSent(params: { user: any; challenge: any; provider_payment_id: string | null }): Promise<boolean> {
  const { user, challenge, provider_payment_id } = params;
  // Idempotency marker for this specific payment
  const reason = provider_payment_id ? `refund_notice_sent:${provider_payment_id}` : "refund_notice_sent";
  const existing = await supabaseAdmin
    .from("wallet_ledger")
    .select("id")
    .eq("user_id", user.id)
    .eq("challenge_id", challenge.id)
    .eq("reason", reason)
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data || []).length > 0) return false;
  const ins = await supabaseAdmin
    .from("wallet_ledger")
    .insert([{ user_id: user.id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason }])
    .select("id")
    .single();
  if (ins.error) throw ins.error;
  return true;
}

async function ensureChatInviteSent(params: { user: any; challenge: any }): Promise<boolean> {
  const { user, challenge } = params;
  const reason = `chat_invite_sent:${challenge.id}`;
  const existing = await supabaseAdmin
    .from("wallet_ledger")
    .select("id")
    .eq("user_id", user.id)
    .eq("challenge_id", challenge.id)
    .eq("reason", reason)
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data || []).length > 0) return false;
  const ins = await supabaseAdmin
    .from("wallet_ledger")
    .insert([{ user_id: user.id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason }]);
  if (ins.error) {
    // best-effort
  }
  return true;
}

// --- Penalties (MVP): state is stored as wallet_ledger markers (reason text) ---
const PENALTY_WINDOW_AFTER_WAKE_MIN = 30; // wake + 30 min (user local timezone)
const PENALTY_LEVELS: Record<number, { squats: number; fine_rub: number } | { kick: true }> = {
  1: { squats: 50, fine_rub: 150 },
  2: { squats: 100, fine_rub: 300 },
  3: { squats: 200, fine_rub: 500 },
  4: { kick: true }
};

function penaltyInfo(level: number): { level: number; squats: number; fine_rub: number; kick: boolean } {
  const row: any = (PENALTY_LEVELS as any)[level] || null;
  if (!row) return { level, squats: 200, fine_rub: 500, kick: level >= 4 };
  if (row.kick) return { level, squats: 0, fine_rub: 0, kick: true };
  return { level, squats: Number(row.squats), fine_rub: Number(row.fine_rub), kick: false };
}

function penaltyReason(kind: string, localDate: string): string {
  return `penalty:${kind}:${localDate}`;
}

async function ledgerHasReason(params: { user_id: string; challenge_id: string; reason: string }): Promise<boolean> {
  const r = await supabaseAdmin
    .from("wallet_ledger")
    .select("id")
    .eq("user_id", params.user_id)
    .eq("challenge_id", params.challenge_id)
    .eq("reason", params.reason)
    .limit(1);
  if (r.error) throw r.error;
  return (r.data || []).length > 0;
}

async function ledgerInsertMarker(params: { user_id: string; challenge_id: string; reason: string }): Promise<void> {
  const ins = await supabaseAdmin
    .from("wallet_ledger")
    .insert([{ user_id: params.user_id, challenge_id: params.challenge_id, delta: 0, currency: "RUB", reason: params.reason }]);
  if (ins.error) {
    // best-effort
  }
}

async function penaltyMissCount(params: { user_id: string; challenge_id: string }): Promise<number> {
  const r = await supabaseAdmin
    .from("wallet_ledger")
    .select("id")
    .eq("user_id", params.user_id)
    .eq("challenge_id", params.challenge_id)
    .ilike("reason", "penalty:miss:%")
    .limit(5000);
  if (r.error) throw r.error;
  return (r.data || []).length;
}

async function todayPenaltyLevel(params: { user_id: string; challenge_id: string; localDate: string }): Promise<number | null> {
  const hasToday = await ledgerHasReason({ user_id: params.user_id, challenge_id: params.challenge_id, reason: penaltyReason("miss", params.localDate) });
  if (!hasToday) return null;
  const n = await penaltyMissCount({ user_id: params.user_id, challenge_id: params.challenge_id });
  return Math.max(1, Math.min(4, n));
}

async function ensureTrialOfferSent(params: { user: any; challenge: any }): Promise<boolean> {
  const { user, challenge } = params;
  const createdAt = user?.created_at ? new Date(user.created_at) : null;
  const seenAt = user?.last_seen_at ? new Date(user.last_seen_at) : createdAt;
  if (!seenAt) return false;
  // Offer after ~2 days of inactivity (MVP). If last_seen_at is unavailable, fallback to created_at.
  if (Date.now() - seenAt.getTime() < 2 * 86400000) return false;

  const existing = await supabaseAdmin.from("wallet_ledger").select("id").eq("user_id", user.id).eq("challenge_id", challenge.id).eq("reason", "trial_offer_sent").limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data || []).length > 0) return false;

  const ins = await supabaseAdmin
    .from("wallet_ledger")
    .insert([{ user_id: user.id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason: "trial_offer_sent" }])
    .select("id")
    .single();
  if (ins.error) throw ins.error;
  return true;
}

async function ensureUser(telegram_user_id: number, opts?: { username?: string | null; first_name?: string | null }) {
  const existing = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
  if (existing.data) {
    // opportunistic update
    const username = opts?.username ?? existing.data.username ?? null;
    const first_name = opts?.first_name ?? existing.data.first_name ?? null;
    const patch: any = { username, first_name, last_seen_at: new Date().toISOString() };
    const updated = await supabaseAdmin.from("users").update(patch).eq("id", existing.data.id).select("*").single();
    if (updated.error && isMissingColumnError(updated.error, "last_seen_at")) {
      const fallback = await supabaseAdmin.from("users").update({ username, first_name }).eq("id", existing.data.id).select("*").single();
      return fallback.data;
    }
    if (updated.data) return updated.data;
    return existing.data;
  }
  const patch: any = {
    telegram_user_id,
    username: opts?.username ?? null,
    first_name: opts?.first_name ?? null,
    last_seen_at: new Date().toISOString()
  };
  const inserted = await supabaseAdmin.from("users").insert([patch]).select("*").single();
  if (inserted.error && isMissingColumnError(inserted.error, "last_seen_at")) {
    const fallback = await supabaseAdmin
      .from("users")
      .insert([
        {
          telegram_user_id,
          username: opts?.username ?? null,
          first_name: opts?.first_name ?? null
        }
      ])
      .select("*")
      .single();
    return fallback.data;
  }
  return inserted.data;
}

async function ensureParticipation(user_id: string, challenge_id: string) {
  const existing = await supabaseAdmin.from("participations").select("*").eq("user_id", user_id).eq("challenge_id", challenge_id).maybeSingle();
  if (existing.data && !existing.data.left_at) return existing.data;
  const upserted = await supabaseAdmin
    .from("participations")
    .upsert(
      [
        {
          user_id,
          challenge_id,
          role: "participant",
          left_at: null
        }
      ],
      { onConflict: "user_id,challenge_id" }
    )
    .select("*")
    .single();
  return upserted.data;
}

export function registerCheckinRoutes(app: FastifyInstance) {
  // POST /payments/webhook (T-Bank/Tinkoff notifications + stub fallback)
  app.post("/payments/webhook", async (req, reply) => {
    const body = (req.body || {}) as any;

    // If no T-Bank creds are configured, keep it as a stub (avoid breaking existing)
    if (!env.TBANK_TERMINAL_KEY || !env.TBANK_PASSWORD) {
      return { ok: true, stub: true };
    }

    // Basic verification
    const terminalKey = String(body.TerminalKey || "");
    const token = String(body.Token || "");
    const paymentId = String(body.PaymentId || "");
    const status = String(body.Status || "");
    if (!terminalKey || !paymentId || !token) {
      reply.code(400);
      return { ok: false, error: "invalid_payload" };
    }
    if (terminalKey !== env.TBANK_TERMINAL_KEY) {
      reply.code(403);
      return { ok: false, error: "terminal_mismatch" };
    }
    const expected = tbankToken(body, env.TBANK_PASSWORD);
    if (expected !== token) {
      reply.code(403);
      return { ok: false, error: "invalid_token" };
    }

    const provider_payment_id = `tbank:${paymentId}`;

    // Determine new status mapping (keep simple)
    const newStatus =
      status === "CONFIRMED" || status === "AUTHORIZED"
        ? "paid"
        : status === "REFUNDED"
          ? "refunded"
          : status === "REJECTED"
            ? "failed"
            : status === "CANCELED"
              ? "failed"
              : "pending";

    const upd = await supabaseAdmin.from("payments").update({ status: newStatus }).eq("provider_payment_id", provider_payment_id).select("*").maybeSingle();

    // Even if we didn't find the payment row (edge cases), return ok so provider stops retrying aggressively.
    return { ok: true, provider: "tbank", payment_id: provider_payment_id, status: newStatus, found: Boolean(upd.data) };
  });

  // --- Bot-facing endpoints (thin; bot should not touch DB directly) ---
  app.post("/bot/upsert-user", async (req) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const username = body.username ?? null;
    const first_name = body.first_name ?? null;

    const existing = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (existing.data) {
      const patch: any = { username, first_name, last_seen_at: new Date().toISOString() };
      const updated = await supabaseAdmin.from("users").update(patch).eq("id", existing.data.id).select("*").single();
      if (updated.error && isMissingColumnError(updated.error, "last_seen_at")) {
        const fallback = await supabaseAdmin.from("users").update({ username, first_name }).eq("id", existing.data.id).select("*").single();
        return { user: fallback.data };
      }
      return { user: updated.data };
    }
    const patch: any = { telegram_user_id, username, first_name, last_seen_at: new Date().toISOString() };
    const inserted = await supabaseAdmin.from("users").insert([patch]).select("*").single();
    if (inserted.error && isMissingColumnError(inserted.error, "last_seen_at")) {
      const fallback = await supabaseAdmin.from("users").insert([{ telegram_user_id, username, first_name }]).select("*").single();
      return { user: fallback.data };
    }
    return { user: inserted.data };
  });

  app.post("/bot/set-timezone", async (req) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const timezone = normalizeTimezoneToStore(String(body.timezone || ""));
    const updated = await supabaseAdmin.from("users").update({ timezone }).eq("telegram_user_id", telegram_user_id).select("*").single();
    return { user: updated.data };
  });

  // POST /bot/pay/create (create T-Bank payment link)
  app.post("/bot/pay/create", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const plan_code = String(body.plan_code || "").trim();
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }

    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    // If currently paid, do not create another payment (bot UI also hides pay button for paid users)
    const accessNow = await getPaidAccessInfo({ user_id: userRes.data.id, challenge_id: challenge.id });
    if (accessNow.is_active_paid) {
      return { ok: false, error: "already_paid", message: "У тебя уже есть оплаченный доступ ✅" };
    }

    if (!env.TBANK_TERMINAL_KEY || !env.TBANK_PASSWORD) {
      reply.code(501);
      return { ok: false, error: "tbank_not_configured", message: "Оплата пока не настроена (нет ключей Т‑Банка)." };
    }
    // Webhook target:
    // - preferred: TBANK_NOTIFICATION_URL (e.g. n8n webhook URL)
    // - fallback: PUBLIC_BASE_URL + /payments/webhook (your public API domain)
    const notificationUrl =
      env.TBANK_NOTIFICATION_URL?.trim() ||
      (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/payments/webhook` : "");
    if (!notificationUrl) {
      reply.code(501);
      return {
        ok: false,
        error: "notification_url_missing",
        message: "Оплата пока не настроена (нет TBANK_NOTIFICATION_URL или PUBLIC_BASE_URL для вебхука)."
      };
    }

    const TARIFFS: Record<string, { title: string; amount_rub: number; days?: number; is_forever?: boolean }> = {
      d30: { title: "30 дней", amount_rub: 490, days: 30 },
      d60: { title: "60 дней", amount_rub: 890, days: 60 },
      d90: { title: "90 дней", amount_rub: 1400, days: 90 },
      life: { title: "Навсегда (поддержать проект)", amount_rub: 3000, is_forever: true }
    };

    const selected = plan_code ? TARIFFS[plan_code] : null;

    const amountRub = (() => {
      if (selected) {
        return selected.amount_rub;
      }
      // Backward compatible fallback (old /pay without plan)
      return Number(env.PAY_PRICE_RUB || "990");
    })();
    if (!Number.isFinite(amountRub) || amountRub <= 0) {
      reply.code(500);
      return { ok: false, error: "invalid_price", message: "Некорректная цена PAY_PRICE_RUB" };
    }
    const amountKopeks = Math.round(amountRub * 100);

    const safePlan = plan_code ? plan_code.replace(/[^\w-]/g, "").slice(0, 16) : "default";
    const orderId = tbankOrderId(["er", challenge.id.slice(0, 8), telegram_user_id, safePlan, Date.now().toString(36)]);
    const description = selected ? `EarlyRise: ${selected.title}` : `EarlyRise: доступ к челленджу`;
    const initPayload: any = {
      TerminalKey: env.TBANK_TERMINAL_KEY,
      Amount: amountKopeks,
      OrderId: orderId,
      Description: description,
      NotificationURL: notificationUrl,
      // Minimal metadata
      DATA: {
        telegram_user_id: String(telegram_user_id),
        user_id: userRes.data.id,
        challenge_id: challenge.id,
        plan_code: selected ? plan_code : safePlan
      }
    };
    initPayload.Token = tbankToken(initPayload, env.TBANK_PASSWORD);

    const r = await fetch("https://securepay.tinkoff.ru/v2/Init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initPayload)
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!r.ok || !json?.Success) {
      reply.code(502);
      const msgParts = [json?.Message, json?.Details, json?.ErrorCode].filter((x) => typeof x === "string" && x.trim());
      const message = msgParts.length ? msgParts.join(" · ") : "Ошибка инициализации платежа";
      return { ok: false, error: "tbank_init_failed", message, raw: json };
    }

    const paymentId = String(json.PaymentId || "");
    const paymentUrl = String(json.PaymentURL || "");
    if (!paymentId || !paymentUrl) {
      reply.code(502);
      return { ok: false, error: "tbank_bad_response", message: "Неожиданный ответ от Т‑Банка", raw: json };
    }

    // Record payment in DB. Provider enum does not include 'tbank' in schema; keep provider='manual' and prefix payment id.
    const basePaymentRow: any = {
      user_id: userRes.data.id,
      challenge_id: challenge.id,
      provider: "manual",
      amount: amountRub,
      currency: "RUB",
      status: "pending",
      provider_payment_id: `tbank:${paymentId}`
    };
    const extendedPaymentRow: any = {
      ...basePaymentRow,
      plan_code: selected ? plan_code : safePlan,
      order_id: orderId,
      access_days: selected?.days ?? null
    };
    let ins: any = await supabaseAdmin.from("payments").insert([extendedPaymentRow]).select("*").single();
    if (ins.error) {
      if (isSchemaColumnIssue(ins.error)) {
        ins = await supabaseAdmin.from("payments").insert([basePaymentRow]).select("*").single();
      }
    }
    if (ins.error) throw ins.error;

    return {
      ok: true,
      payment_url: paymentUrl,
      payment_id: ins.data.id,
      provider_payment_id: ins.data.provider_payment_id,
      plan: selected ? { code: plan_code, title: selected.title, amount_rub: selected.amount_rub } : null
    };
  });

  app.get("/bot/me/:telegramUserId", async (req) => {
    const telegramUserId = Number((req.params as any).telegramUserId);
    const user = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
    if (!user.data) return { user: null };
    const stats = await supabaseAdmin.from("user_stats").select("*").eq("user_id", user.data.id).maybeSingle();
    const challenge = await getActiveChallenge();
    if (!challenge) {
      await touchUserLastSeen(user.data.id);
      return { user: user.data, stats: stats.data, access: { status: "lead" }, offer: null };
    }
    const paidInfo = await getPaidAccessInfo({ user_id: user.data.id, challenge_id: challenge.id });
    const trialUntil = await getTrialUntilUtc(user.data.id, challenge.id);
    const trialActive = isFutureIso(trialUntil);
    const status: AccessStatus = paidInfo.is_active_paid
      ? "paid"
      : trialActive
        ? "trial"
        : paidInfo.has_any_paid
          ? "expired"
          : "lead";

    let offer: any = null;
    // Refund notice (automatic): if last payment is refunded and user is not currently paid.
    if (!paidInfo.is_active_paid) {
      const latestPayment = await getLatestPayment({ user_id: user.data.id, challenge_id: challenge.id });
      if (latestPayment?.status === "refunded") {
        const sent = await ensureRefundNoticeSent({
          user: user.data,
          challenge,
          provider_payment_id: latestPayment.provider_payment_id
        });
        if (sent) {
          offer = {
            type: "refund_notice",
            message:
              "Вижу возврат по оплате.\n\n" +
              "Если хочешь продолжить участие — открой /menu и нажми «💳 Оплатить участие»."
          };
        }
      }
    }
    if (!offer && status === "lead") {
      // If offer was already sent proactively, still show the button in UI (but don't spam the message again).
      const existingOffer = await supabaseAdmin
        .from("wallet_ledger")
        .select("id")
        .eq("user_id", user.data.id)
        .eq("challenge_id", challenge.id)
        .eq("reason", "trial_offer_sent")
        .limit(1);
      if (existingOffer.error) throw existingOffer.error;
      const alreadySent = (existingOffer.data || []).length > 0;
      if (alreadySent) {
        offer = { type: "trial_7d", message: null };
      } else {
        const sent = await ensureTrialOfferSent({ user: user.data, challenge });
        if (sent) {
          offer = {
            type: "trial_7d",
            message:
              "Вижу ты уже несколько дней присматриваешься 👀\n\n" +
              "Хочешь попробовать бесплатно 7 дней?\n" +
              "- открой /menu и нажми «🎁 Пробная неделя»\n" +
              "- или напиши /trial\n\n" +
              "Вопросы лучше обсуждать в общем чате с участниками."
          };
        }
      }
    }

    if (!offer && status === "paid") {
      const sent = await ensureChatInviteSent({ user: user.data, challenge });
      if (sent) {
        const link = env.EARLYRISE_PUBLIC_CHAT_INVITE_URL?.trim() || "https://t.me/+_9uHztv4J7MxMWNi";
        offer = {
          type: "chat_invite",
          message:
            "Отлично, оплата прошла ✅\n\n" +
            "Вот ссылка на общий чат участников:\n" +
            link
        };
      }
    }

    if (!offer && status === "expired") {
      offer = {
        type: "renew_prompt",
        message: "Срок участия закончился ⛔️\n\nОткрой /menu и нажми «Восстановить участие», чтобы выбрать тариф."
      };
    }

    const payload = {
      user: user.data,
      stats: stats.data,
      challenge: { id: challenge.id, title: challenge.title },
      access: { status, trial_until_utc: trialUntil, paid_until_utc: paidInfo.paid_until_utc, paid_forever: paidInfo.is_forever },
      offer
    };
    // Best-effort store computed paid_until for admin/cron usage (ignore if column missing)
    try {
      const patch: any = { paid_until: paidInfo.is_forever ? null : paidInfo.paid_until_utc };
      const upd = await supabaseAdmin.from("users").update(patch).eq("id", user.data.id);
      if (upd.error && isMissingColumnError(upd.error, "paid_until")) {
        // ignore for older schemas
      }
    } catch {
      // ignore
    }
    await touchUserLastSeen(user.data.id);
    return payload;
  });

  // POST /bot/penalty/choose
  // body: { telegram_user_id: number, local_date: "YYYY-MM-DD", choice: "task"|"pay" }
  app.post("/bot/penalty/choose", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    let local_date = String(body.local_date || "").trim();
    const choice = String(body.choice || "").trim();
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }
    if (choice !== "task" && choice !== "pay") {
      reply.code(400);
      return { ok: false, error: "invalid_choice" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found" };
    }
    if (!local_date) {
      const tz = userRes.data.timezone || "GMT+00:00";
      local_date = utcRangeForLocalDay({ now: new Date(), timeZone: tz }).localDate;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(local_date)) {
      reply.code(400);
      return { ok: false, error: "invalid_local_date" };
    }

    const level = await todayPenaltyLevel({ user_id: userRes.data.id, challenge_id: challenge.id, localDate: local_date });
    if (!level) {
      reply.code(409);
      return { ok: false, error: "no_penalty_today", message: "Сегодня штраф не назначен." };
    }
    const info = penaltyInfo(level);
    if (info.kick) {
      reply.code(409);
      return { ok: false, error: "kicked", message: "Это 4-й пропуск: участие остановлено." };
    }

    await ledgerInsertMarker({ user_id: userRes.data.id, challenge_id: challenge.id, reason: penaltyReason(`choice_${choice}`, local_date) });

    if (choice === "task") {
      return {
        ok: true,
        choice,
        level,
        squats: info.squats,
        fine_rub: info.fine_rub,
        message: `Ок.\n\nПришли видео с приседаниями ${info.squats} раз до 23:59 по твоей таймзоне сегодня.\n\nЯ отправлю куратору на проверку.`
      };
    }

    return {
      ok: true,
      choice,
      level,
      squats: info.squats,
      fine_rub: info.fine_rub,
      message: `Ок.\n\nОплати штраф ${info.fine_rub} ₽ до 23:59 сегодня. Сейчас пришлю ссылку на оплату.`
    };
  });

  // POST /bot/penalty/pay/create (create T-Bank payment link for fine)
  // body: { telegram_user_id: number, local_date: "YYYY-MM-DD" }
  app.post("/bot/penalty/pay/create", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    let local_date = String(body.local_date || "").trim();
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }
    if (!local_date) {
      const tz = userRes.data.timezone || "GMT+00:00";
      local_date = utcRangeForLocalDay({ now: new Date(), timeZone: tz }).localDate;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(local_date)) {
      reply.code(400);
      return { ok: false, error: "invalid_local_date" };
    }
    const level = await todayPenaltyLevel({ user_id: userRes.data.id, challenge_id: challenge.id, localDate: local_date });
    if (!level) {
      reply.code(409);
      return { ok: false, error: "no_penalty_today", message: "Сегодня штраф не назначен." };
    }
    const info = penaltyInfo(level);
    if (info.kick) {
      reply.code(409);
      return { ok: false, error: "kicked", message: "Это 4-й пропуск: участие остановлено." };
    }

    if (!env.TBANK_TERMINAL_KEY || !env.TBANK_PASSWORD) {
      reply.code(501);
      return { ok: false, error: "tbank_not_configured", message: "Оплата пока не настроена (нет ключей Т‑Банка)." };
    }
    const notificationUrl =
      env.TBANK_NOTIFICATION_URL?.trim() ||
      (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/payments/webhook` : "");
    if (!notificationUrl) {
      reply.code(501);
      return { ok: false, error: "notification_url_missing", message: "Нет TBANK_NOTIFICATION_URL или PUBLIC_BASE_URL для вебхука." };
    }

    const amountRub = info.fine_rub;
    const amountKopeks = Math.round(amountRub * 100);
    const dateCompact = local_date.replace(/-/g, ""); // YYYYMMDD
    const orderId = tbankOrderId(["erP", challenge.id.slice(0, 6), telegram_user_id, dateCompact, `L${level}`, Date.now().toString(36)]);
    const initPayload: any = {
      TerminalKey: env.TBANK_TERMINAL_KEY,
      Amount: amountKopeks,
      OrderId: orderId,
      Description: `EarlyRise: штраф (уровень ${level})`,
      NotificationURL: notificationUrl,
      DATA: {
        kind: "penalty",
        telegram_user_id: String(telegram_user_id),
        user_id: userRes.data.id,
        challenge_id: challenge.id,
        local_date,
        level: String(level)
      }
    };
    initPayload.Token = tbankToken(initPayload, env.TBANK_PASSWORD);

    const r = await fetch("https://securepay.tinkoff.ru/v2/Init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initPayload)
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!r.ok || !json?.Success) {
      reply.code(502);
      const msgParts = [json?.Message, json?.Details, json?.ErrorCode].filter((x) => typeof x === "string" && x.trim());
      const message = msgParts.length ? msgParts.join(" · ") : "Ошибка инициализации платежа";
      return { ok: false, error: "tbank_init_failed", message, raw: json };
    }
    const paymentId = String(json.PaymentId || "");
    const paymentUrl = String(json.PaymentURL || "");
    if (!paymentId || !paymentUrl) {
      reply.code(502);
      return { ok: false, error: "tbank_bad_response", message: "Неожиданный ответ от Т‑Банка", raw: json };
    }

    // Insert payment row (best-effort; tolerate missing columns)
    const baseRow: any = {
      user_id: userRes.data.id,
      challenge_id: challenge.id,
      provider: "manual",
      amount: amountRub,
      currency: "RUB",
      status: "pending",
      provider_payment_id: `tbank:${paymentId}`
    };
    const extendedRow: any = { ...baseRow, order_id: orderId, plan_code: `penalty_l${level}`, access_days: null };
    let ins: any = await supabaseAdmin.from("payments").insert([extendedRow]).select("*").single();
    if (ins.error) {
      if (isSchemaColumnIssue(ins.error)) {
        ins = await supabaseAdmin.from("payments").insert([baseRow]).select("*").single();
      }
    }
    if (ins.error) throw ins.error;

    await ledgerInsertMarker({
      user_id: userRes.data.id,
      challenge_id: challenge.id,
      reason: `penalty:pay_intent:${local_date}|${ins.data.provider_payment_id}|${amountRub}`
    });

    return { ok: true, payment_url: paymentUrl, amount_rub: amountRub, provider_payment_id: ins.data.provider_payment_id, level };
  });

  // POST /bot/penalty/task/submit (mark that user sent video; bot forwards it to curator separately)
  // body: { telegram_user_id: number, local_date: "YYYY-MM-DD", message_id: number, file_id?: string }
  app.post("/bot/penalty/task/submit", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    let local_date = String(body.local_date || "").trim();
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found" };
    }
    if (!local_date) {
      const tz = userRes.data.timezone || "GMT+00:00";
      local_date = utcRangeForLocalDay({ now: new Date(), timeZone: tz }).localDate;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(local_date)) {
      reply.code(400);
      return { ok: false, error: "invalid_local_date" };
    }
    const level = await todayPenaltyLevel({ user_id: userRes.data.id, challenge_id: challenge.id, localDate: local_date });
    if (!level) {
      reply.code(409);
      return { ok: false, error: "no_penalty_today" };
    }
    const info = penaltyInfo(level);
    if (info.kick) {
      reply.code(409);
      return { ok: false, error: "kicked" };
    }

    const chosen = await ledgerHasReason({ user_id: userRes.data.id, challenge_id: challenge.id, reason: penaltyReason("choice_task", local_date) });
    if (!chosen) {
      reply.code(409);
      return { ok: false, error: "task_not_chosen", message: "Сначала выбери «Выполнить штрафное задание»." };
    }

    await ledgerInsertMarker({ user_id: userRes.data.id, challenge_id: challenge.id, reason: `penalty:task_submitted:${local_date}` });
    const curatorId = env.CURATOR_TELEGRAM_USER_ID ? Number(env.CURATOR_TELEGRAM_USER_ID) : NaN;
    return {
      ok: true,
      local_date,
      level,
      squats: info.squats,
      curator_telegram_user_id: Number.isFinite(curatorId) ? curatorId : null
    };
  });

  // POST /bot/penalty/task/approve (curator confirms)
  // body: { telegram_user_id: number, local_date: "YYYY-MM-DD", curator_telegram_user_id: number }
  app.post("/bot/penalty/task/approve", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const local_date = String(body.local_date || "").trim();
    const curator_telegram_user_id = Number(body.curator_telegram_user_id);
    if (!telegram_user_id || !curator_telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_ids" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(local_date)) {
      reply.code(400);
      return { ok: false, error: "invalid_local_date" };
    }
    const configured = env.CURATOR_TELEGRAM_USER_ID ? Number(env.CURATOR_TELEGRAM_USER_ID) : NaN;
    if (!Number.isFinite(configured) || configured !== curator_telegram_user_id) {
      reply.code(403);
      return { ok: false, error: "forbidden" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found" };
    }
    await ledgerInsertMarker({ user_id: userRes.data.id, challenge_id: challenge.id, reason: `penalty:task_approved:${local_date}` });
    return { ok: true };
  });

  // POST /bot/trial/claim (enable 7-day free trial for active challenge)
  app.post("/bot/trial/claim", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }
    const paidInfo = await getPaidAccessInfo({ user_id: userRes.data.id, challenge_id: challenge.id });
    if (paidInfo.is_active_paid) {
      return { ok: false, error: "already_paid", message: "У тебя уже есть оплаченный доступ ✅" };
    }
    const trialUntil = await getTrialUntilUtc(userRes.data.id, challenge.id);
    if (trialUntil && isFutureIso(trialUntil)) {
      return { ok: false, error: "trial_active", message: `Пробная неделя уже активна до ${fmtDateRu(new Date(trialUntil))}` };
    }

    const ins = await supabaseAdmin
      .from("wallet_ledger")
      .insert([{ user_id: userRes.data.id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason: "trial_7d_start" }])
      .select("created_at")
      .single();
    if (ins.error) throw ins.error;
    const start = new Date(ins.data.created_at);
    const until = new Date(start.getTime() + 7 * 86400000).toISOString();
    return { ok: true, message: `Готово ✅ Пробная неделя активна до ${fmtDateRu(new Date(until))}.`, trial_until_utc: until };
  });

  // POST /bot/join
  // body: { telegram_user_id: number, wake_time_local: "HH:MM" | "flex" }
  app.post("/bot/join", async (req, reply) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const wakeRaw = String(body.wake_time_local || "").trim();
    const parsedMode = parseWakeMode(wakeRaw);
    if (!parsedMode) {
      reply.code(400);
      return {
        ok: false,
        error: "invalid_wake_time",
        message: "Формат: /join 07:00\nДоступные режимы: 05:00, 06:00, 07:00, 08:00, 09:00\nИли режим без времени: /join flex"
      };
    }

    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    const tz = userRes.data.timezone || "GMT+00:00";
    const now = new Date();
    let wakeStr: string | null = null;
    let wakeUtcMinutes: number | null = null;
    const wake_mode: "fixed" | "flex" = parsedMode.wake_mode;
    if (parsedMode.wake_mode === "fixed") {
      wakeStr = parsedMode.wake_time_hhmm;
      // Compute wake_utc_minutes (MVP approximation): use current timezone offset by comparing local parts to UTC.
      const parsedOffset = parseGmtOffsetToMinutes(tz);
      const offsetMinutes =
        parsedOffset !== null
          ? parsedOffset
          : (() => {
              const local = getLocalParts(now, tz);
              const localNowUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0));
              return Math.round((localNowUtc.getTime() - now.getTime()) / 60000); // local - utc in minutes
            })();
      const parsedWake = parseTimeHHMM(parsedMode.wake_time_hhmm);
      if (!parsedWake) {
        reply.code(400);
        return { ok: false, error: "invalid_wake_time", message: "Некорректное время подъёма" };
      }
      const wakeLocalMinutes = minutesOfDay(parsedWake.hour, parsedWake.minute);
      wakeUtcMinutes = (wakeLocalMinutes - offsetMinutes + 1440) % 1440;
    }

    // ensure participation exists
    const existing = await supabaseAdmin.from("participations").select("*").eq("user_id", userRes.data.id).eq("challenge_id", challenge.id).maybeSingle();

    if (existing.data && !existing.data.left_at) {
      // update wake time/mode (allowed)
      const upd = await supabaseAdmin.from("participations").update({ wake_mode, wake_time_local: wakeStr, wake_utc_minutes: wakeUtcMinutes }).eq("id", existing.data.id).select("*").single();
      return { ok: true, participation: upd.data, challenge, wake_mode, wake_time_local: wakeStr };
    }

    const inserted = await supabaseAdmin
      .from("participations")
      .upsert(
        [
          {
            user_id: userRes.data.id,
            challenge_id: challenge.id,
            role: "participant",
            left_at: null,
            wake_mode,
            wake_time_local: wakeStr,
            wake_utc_minutes: wakeUtcMinutes
          }
        ],
        { onConflict: "user_id,challenge_id" }
      )
      .select("*")
      .single();

    return { ok: true, participation: inserted.data, challenge, wake_mode, wake_time_local: wakeStr };
  });

  // POST /bot/checkin/text
  // body: { telegram_user_id: number, text: string }
  app.post("/bot/checkin/text", async (req, reply) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const text = String(body.text || "").trim();
    if (!text) {
      reply.code(400);
      return { ok: false, error: "empty_text" };
    }

    const settings = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
    if (!settings.data || settings.data.challenge_active === false) {
      reply.code(409);
      return { ok: false, error: "challenge_inactive", message: "Челлендж сейчас выключен" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }

    const partRes = await supabaseAdmin.from("participations").select("*").eq("user_id", userRes.data.id).eq("challenge_id", challenge.id).maybeSingle();
    if (!partRes.data || partRes.data.left_at) {
      reply.code(409);
      return { ok: false, error: "not_joined", message: "Сначала /join HH:MM" };
    }

    const wakeStr = String(partRes.data.wake_time_local || "").trim();
    const parsedWake = wakeStr ? parseTimeHHMM(wakeStr) : null;
    if (!parsedWake) {
      reply.code(409);
      return { ok: false, error: "missing_wake_time", message: "Нужно указать время подъёма: /join HH:MM" };
    }

    const tz = userRes.data.timezone || "GMT+00:00";
    const now = new Date();
    const localNow = getLocalParts(now, tz);
    const nowMinutes = minutesOfDay(localNow.hour, localNow.minute);
    const wakeMinutes = minutesOfDay(parsedWake.hour, parsedWake.minute);
    const window = Number(settings.data.checkin_window_minutes || 30);

    if (!isInWindow(nowMinutes, wakeMinutes, window)) {
      // record rejected checkin (optional; for MVP we record rejected too)
      const inserted = await supabaseAdmin
        .from("checkins")
        .insert([
          {
            user_id: userRes.data.id,
            challenge_id: challenge.id,
            checkin_at_utc: now.toISOString(),
            source: "text",
            status: "rejected",
            reject_reason: "outside_window",
            raw_text: text
          }
        ])
        .select("*")
        .single();
      reply.code(200);
      const endMinutes = wakeMinutes + window;
      return {
        ok: false,
        error: "outside_window",
        message: `Окно чек-ина (${tz}): ${fmtHHMM(wakeMinutes)}–${fmtHHMM(endMinutes)}. Сейчас: ${fmtHHMM(nowMinutes)}.`,
        checkin: inserted.data
      };
    }

    const inserted = await supabaseAdmin
      .from("checkins")
      .insert([
        {
          user_id: userRes.data.id,
          challenge_id: challenge.id,
          checkin_at_utc: now.toISOString(),
          source: "text",
          status: "approved",
          raw_text: text
        }
      ])
      .select("*")
      .single();

    return { ok: true, checkin: inserted.data };
  });

  // POST /bot/checkin/plus (group flow)
  // body: { telegram_user_id: number, text: string, chat_id?: number, message_id?: number, username?: string|null, first_name?: string|null }
  app.post("/bot/checkin/plus", async (req, reply) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const text = String(body.text || "").trim();
    if (!text) {
      reply.code(400);
      return { ok: false, error: "empty_text" };
    }

    const settings = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
    if (!settings.data || settings.data.challenge_active === false) {
      reply.code(409);
      return { ok: false, error: "challenge_inactive", message: "Челлендж сейчас выключен" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    // Upsert user; participation must exist with wake_mode to validate "in time"
    const user = await ensureUser(telegram_user_id, { username: body.username ?? null, first_name: body.first_name ?? null });
    const partRes = await supabaseAdmin.from("participations").select("*").eq("user_id", user.id).eq("challenge_id", challenge.id).maybeSingle();
    const part = partRes.data;
    const tz = user.timezone || "GMT+00:00";
    const now = new Date();
    const localDate = localDateString(now, tz);

    if (!part || part.left_at) {
      // record rejected for audit
      const inserted = await supabaseAdmin.from("checkins").insert([
        {
          user_id: user.id,
          challenge_id: challenge.id,
          checkin_at_utc: now.toISOString(),
          source: "text",
          status: "rejected",
          reject_reason: "not_joined",
          raw_text: JSON.stringify({ kind: "group_plus", chat_id: body.chat_id, message_id: body.message_id, text })
        }
      ]);
      reply.code(200);
      return { ok: false, error: "not_joined", message: "Сначала /join", local_date: localDate, checkin: inserted.data?.[0] ?? null };
    }

    const wake_mode: string = String((part as any).wake_mode || "fixed");
    let inTime = true;
    let reason: string | null = null;
    if (wake_mode !== "flex") {
      const wakeStr = String((part as any).wake_time_local || "").trim();
      const parsedWake = wakeStr ? parseTimeHHMM(wakeStr) : null;
      if (!parsedWake) {
        inTime = false;
        reason = "missing_wake_time";
      } else {
        const localNow = getLocalParts(now, tz);
        const nowMinutes = minutesOfDay(localNow.hour, localNow.minute);
        const wakeMinutes = minutesOfDay(parsedWake.hour, parsedWake.minute);
        const afterLimit = 10; // +10 минут
        const beforeLimit = 55; // -55 минут
        const earliest = (wakeMinutes - beforeLimit + 1440) % 1440;
        const latest = (wakeMinutes + afterLimit) % 1440;
        // Spec (updated): "+" must be within [wake-55; wake+10] in user's local time.
        inTime = inMinutesRangeCircular(nowMinutes, earliest, latest);
        reason = inTime ? null : "outside_window";
      }
    }

    const meta = {
      kind: "group_plus",
      chat_id: typeof body.chat_id === "number" ? body.chat_id : undefined,
      message_id: typeof body.message_id === "number" ? body.message_id : undefined,
      text
    };

    if (!inTime) {
      const inserted = await supabaseAdmin
        .from("checkins")
        .insert([
          {
            user_id: user.id,
            challenge_id: challenge.id,
            checkin_at_utc: now.toISOString(),
            source: "text",
            status: "rejected",
            reject_reason: reason || "outside_window",
            raw_text: JSON.stringify(meta)
          }
        ])
        .select("*")
        .single();
      reply.code(200);
      return { ok: false, error: reason || "outside_window", local_date: localDate, checkin: inserted.data };
    }

    const inserted = await supabaseAdmin
      .from("checkins")
      .insert([
        {
          user_id: user.id,
          challenge_id: challenge.id,
          checkin_at_utc: now.toISOString(),
          source: "text",
          status: "approved",
          raw_text: JSON.stringify(meta)
        }
      ])
      .select("*")
      .single();

    const voiceDone = await hasVoiceCheckinForLocalDay({ user_id: user.id, challenge_id: challenge.id, timeZone: tz, now });
    return { ok: true, local_date: localDate, needs_voice: !voiceDone, checkin: inserted.data };
  });

  // POST /bot/checkin/voice (MVP: record voice as check-in; transcript optional)
  app.post("/bot/checkin/voice", async (req, reply) => {
    const body = req.body as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const file_id = String(body.file_id || "").trim();
    const duration = body.duration !== undefined ? Number(body.duration) : undefined;
    const audio_base64 = body.audio_base64 ? String(body.audio_base64).trim() : "";
    const audio_mime = body.audio_mime ? String(body.audio_mime).trim() : "audio/ogg";
    if (!file_id) {
      reply.code(400);
      return { ok: false, error: "missing_file_id" };
    }

    const settings = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
    if (!settings.data || settings.data.challenge_active === false) {
      reply.code(409);
      return { ok: false, error: "challenge_inactive", message: "Челлендж сейчас выключен" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    const user = await ensureUser(telegram_user_id, { username: body.username ?? null, first_name: body.first_name ?? null });
    await ensureParticipation(user.id, challenge.id);

    // Penalty mode: after wake+30 (local time) do not accept voice check-ins for fixed wake users.
    // Flex users are exempt.
    try {
      const partRes = await supabaseAdmin
        .from("participations")
        .select("wake_mode, wake_time_local, left_at")
        .eq("user_id", user.id)
        .eq("challenge_id", challenge.id)
        .maybeSingle();
      if (!partRes.error && partRes.data && !partRes.data.left_at) {
        const wakeMode = String((partRes.data as any).wake_mode || "fixed");
        if (wakeMode !== "flex") {
          const wakeStr = String((partRes.data as any).wake_time_local || "").trim();
          const parsedWake = wakeStr ? parseTimeHHMM(wakeStr) : null;
          if (parsedWake) {
            const tz = user.timezone || "GMT+00:00";
            const localNow = getLocalParts(new Date(), tz);
            const nowMinutes = minutesOfDay(localNow.hour, localNow.minute);
            const wakeMinutes = minutesOfDay(parsedWake.hour, parsedWake.minute);
            const cutoff = wakeMinutes + 30;
            if (nowMinutes > cutoff) {
              reply.code(200);
              return {
                ok: false,
                error: "penalty_mode",
                message:
                  "Сейчас уже штрафной режим: прошло больше 30 минут после времени подъёма.\n\n" +
                  "Голосовые после wake+30 не принимаю.\n\n" +
                  "Если нужно — открой /menu."
              };
            }
          }
        }
      }
    } catch {
      // best-effort: if this check fails, keep old behavior
    }

    // Allow only 1 voice check-in per local day (based on user's timezone)
    const tz = user.timezone || "GMT+00:00";
    const { startUtcIso, endUtcIso } = utcRangeForLocalDay({ now: new Date(), timeZone: tz });
    const existingVoice = await supabaseAdmin
      .from("checkins")
      .select("id")
      .eq("user_id", user.id)
      .eq("challenge_id", challenge.id)
      .eq("source", "voice")
      .in("status", ["pending", "approved"] as any)
      .gte("checkin_at_utc", startUtcIso)
      .lte("checkin_at_utc", endUtcIso)
      .limit(1);
    if (existingVoice.error) throw existingVoice.error;
    if ((existingVoice.data || []).length > 0) {
      reply.code(200);
      return {
        ok: false,
        error: "already_voice_today",
        message:
          "Голосовое уже принято сегодня ✅\n\n" +
          "Следующее голосовое ждём завтра.\n\n" +
          "Если есть вопросы или хочется обсудить детали — лучше написать в общий чат с участниками."
      };
    }

    const meta = {
      kind: "voice",
      chat_id: typeof body.chat_id === "number" ? body.chat_id : undefined,
      message_id: typeof body.message_id === "number" ? body.message_id : undefined,
      file_id,
      duration: Number.isFinite(duration) ? duration : undefined
    };

    const inserted = await supabaseAdmin
      .from("checkins")
      .insert([
        {
          user_id: user.id,
          challenge_id: challenge.id,
          checkin_at_utc: new Date().toISOString(),
          source: "voice",
          status: "pending",
          requires_anticheat: true,
          anticheat_passed: false,
          raw_text: JSON.stringify(meta)
        }
      ])
      .select("*")
      .single();

    // Optional: store audio in Supabase Storage (retention is handled separately)
    const stored = await maybeStoreVoiceAudio({
      checkin_id: inserted.data.id,
      checkin_at_utc: inserted.data.checkin_at_utc,
      audio_base64,
      audio_mime
    });

    // Voice transcript + curator feedback
    let transcript: string | null = null;
    let confidence: number | null = null;
    let replyText: string | null = null;
    let raw: any = { skipped: true, reason: "mvp_no_n8n" };

    const voiceEnabled = settings.data.voice_feedback_enabled !== false;
    if (!voiceEnabled) {
      replyText = "Принял голосовое. (Сейчас фидбек по голосу отключён в настройках.)";
    } else {
      const prefer = (env.VOICE_PROVIDER || "").toLowerCase(); // "n8n" | "openai" | ""
      const canUseN8n = Boolean(env.N8N_WEBHOOK_URL && audio_base64);
      const canUseOpenAI = Boolean(env.OPENAI_API_KEY && audio_base64);

      const callN8n = async (): Promise<boolean> => {
        if (!canUseN8n) return false;
        const payload = {
          event: "earlyrise_voice_checkin",
          mode: "voice",
          prompt: { system: CURATOR_SYSTEM_PROMPT },
          user: {
            telegram_user_id,
            username: user.username,
            first_name: user.first_name,
            timezone: user.timezone
          },
          challenge: { id: challenge.id, title: challenge.title },
          checkin: { id: inserted.data.id, checkin_at_utc: inserted.data.checkin_at_utc, duration: meta.duration },
          telegram: { chat_id: meta.chat_id, message_id: meta.message_id, file_id },
          audio: { mime: audio_mime, base64: audio_base64 }
        };
        // n8n can occasionally take >30s (OpenAI latency). Keep logs minimal (no PII).
        console.log(
          "calling n8n voice webhook",
          { checkin_id: inserted.data.id, challenge_id: payload.challenge?.id, mime: payload.audio?.mime, size: payload.audio?.base64?.length ?? 0 }
        );
        const r = await postJson(env.N8N_WEBHOOK_URL!, payload, 60000);
        const j = r.json || {};
        console.log("n8n voice response", { checkin_id: inserted.data.id, status: r.status, ok: r.ok, has_json: Boolean(r.json) });
        transcript = typeof j.transcript === "string" ? j.transcript : typeof j.text === "string" ? j.text : transcript;
        confidence = typeof j.confidence === "number" ? j.confidence : confidence;
        replyText = typeof j.reply === "string" ? j.reply : fallbackCuratorReply(transcript || null);
        raw = { n8n: { status: r.status, ok: r.ok, json: r.json ?? null } };
        return true;
      };

      const callOpenAI = async (): Promise<boolean> => {
        if (!canUseOpenAI) return false;
        const audioBytes = new Uint8Array(Buffer.from(audio_base64, "base64"));
        const stt = await openaiTranscribe({
          apiKey: env.OPENAI_API_KEY!,
          model: env.OPENAI_STT_MODEL || "whisper-1",
          audioBytes,
          mime: audio_mime || "audio/ogg"
        });
        transcript = stt.transcript || null;
        confidence = null;
        const chat = await openaiCuratorReply({
          apiKey: env.OPENAI_API_KEY!,
          model: env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
          system: CURATOR_SYSTEM_PROMPT,
          transcript: transcript || "",
          language: "",
          timezone: user.timezone
        });
        replyText = chat.reply;
        raw = { openai: { stt: stt.raw, chat: chat.raw } };
        return true;
      };

      const attempts: Array<() => Promise<boolean>> =
        prefer === "n8n" ? [callN8n, callOpenAI] : prefer === "openai" ? [callOpenAI, callN8n] : [callOpenAI, callN8n];

      try {
        let ok = false;
        for (const fn of attempts) {
          try {
            ok = await fn();
            if (ok) break;
          } catch (e: any) {
            raw = { ...raw, error: true, message: e?.message || String(e) };
          }
        }
        if (!ok) replyText = fallbackCuratorReply(null);
      } catch {
        replyText = fallbackCuratorReply(null);
      }
    }

    // Voice transcript row.
    // Note: storage pointer columns may not exist yet if migration wasn't applied.
    const vtBase: any = {
      checkin_id: inserted.data.id,
      provider: env.VOICE_PROVIDER?.toLowerCase() === "n8n" ? "n8n" : env.OPENAI_API_KEY ? "openai" : "mvp",
      transcript,
      confidence,
      raw,
      reply_text: replyText
    };
    const vtWithAudio: any = {
      ...vtBase,
      audio_storage_bucket: stored?.bucket || null,
      audio_storage_path: stored?.path || null,
      audio_mime: stored ? audio_mime : null,
      audio_bytes: stored ? stored.bytes : null
    };
    {
      const ins1 = await supabaseAdmin.from("voice_transcripts").insert([vtWithAudio]);
      if (ins1.error) {
        const msg = String((ins1.error as any).message || (ins1.error as any).details || ins1.error);
        // Fallback for older schema (no storage columns yet).
        if (/audio_storage_|audio_bytes|audio_mime/i.test(msg) || /column .* does not exist/i.test(msg)) {
          const ins2 = await supabaseAdmin.from("voice_transcripts").insert([vtBase]);
          if (ins2.error) throw ins2.error;
        } else {
          throw ins1.error;
        }
      }
    }

    // Anti-cheat challenge (simple arithmetic). User must solve it to "count the day".
    const anti = generateAntiCheat();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes
    await supabaseAdmin.from("anti_cheat_challenges").insert([
      {
        checkin_id: inserted.data.id,
        user_id: user.id,
        challenge_id: challenge.id,
        question: anti.question,
        answer_int: anti.answer_int,
        attempts: 0,
        status: "pending",
        expires_at_utc: expiresAt
      }
    ]);

    return {
      ok: true,
      checkin: inserted.data,
      reply_text: replyText || fallbackCuratorReply(transcript || null),
      anti_cheat: { checkin_id: inserted.data.id, question: anti.question, expires_at_utc: expiresAt }
    };
  });

  // POST /bot/checkin/dm_text
  app.post("/bot/checkin/dm_text", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const text = String(body.text || "").trim();
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }
    if (!text) {
      reply.code(400);
      return { ok: false, error: "empty_text" };
    }

    const settings = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
    if (!settings.data || settings.data.challenge_active === false) {
      reply.code(409);
      return { ok: false, error: "challenge_inactive", message: "Челлендж сейчас выключен" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    const user = await ensureUser(telegram_user_id, { username: body.username ?? null, first_name: body.first_name ?? null });
    await ensureParticipation(user.id, challenge.id);

    // Allow only 1 voice-like check-in per local day (based on user's timezone)
    const tz = user.timezone || "GMT+00:00";
    const { startUtcIso, endUtcIso } = utcRangeForLocalDay({ now: new Date(), timeZone: tz });
    const existing = await supabaseAdmin
      .from("checkins")
      .select("id")
      .eq("user_id", user.id)
      .eq("challenge_id", challenge.id)
      .eq("source", "voice")
      .in("status", ["pending", "approved"] as any)
      .gte("checkin_at_utc", startUtcIso)
      .lte("checkin_at_utc", endUtcIso)
      .limit(1);
    if (existing.error) throw existing.error;
    if ((existing.data || []).length > 0) {
      reply.code(200);
      return {
        ok: false,
        error: "already_voice_today",
        message:
          "Чек-ин уже принят сегодня ✅\n\n" +
          "Следующий чек-ин ждём завтра.\n\n" +
          "Если есть вопросы или хочется обсудить детали — лучше написать в общий чат с участниками."
      };
    }

    const meta = { kind: "dm_text", text_preview: text.slice(0, 140) };
    const inserted = await supabaseAdmin
      .from("checkins")
      .insert([
        {
          user_id: user.id,
          challenge_id: challenge.id,
          checkin_at_utc: new Date().toISOString(),
          source: "voice",
          status: "pending",
          requires_anticheat: true,
          anticheat_passed: false,
          raw_text: JSON.stringify(meta)
        }
      ])
      .select("*")
      .single();

    // Curator reply for DM text:
    let replyText: string = fallbackCuratorReply(text);
    let raw: any = { dm_text: true };
    const prefer = (env.VOICE_PROVIDER || "").toLowerCase(); // reuse VOICE_PROVIDER as "ai provider preference"
    const textWebhook = env.N8N_TEXT_WEBHOOK_URL || env.N8N_WEBHOOK_URL;
    const canUseN8n = Boolean(textWebhook);
    const canUseOpenAI = Boolean(env.OPENAI_API_KEY);

    const callN8n = async (): Promise<boolean> => {
      if (!canUseN8n) return false;
      const payload = {
        event: "earlyrise_text_checkin",
        mode: "text",
        prompt: { system: CURATOR_SYSTEM_PROMPT },
        user: {
          telegram_user_id,
          username: user.username,
          first_name: user.first_name,
          timezone: user.timezone
        },
        challenge: { id: challenge.id, title: challenge.title },
        checkin: { id: inserted.data.id, checkin_at_utc: inserted.data.checkin_at_utc, source: "dm_text" },
        text: { content: text }
      };
      const r = await postJson(textWebhook!, payload, 45000);
      const j = r.json || {};
      replyText = typeof j.reply === "string" ? j.reply : fallbackCuratorReply(text);
      raw = { n8n: { status: r.status, ok: r.ok, json: r.json ?? null } };
      return true;
    };

    const callOpenAI = async (): Promise<boolean> => {
      if (!canUseOpenAI) return false;
      const chat = await openaiCuratorReply({
        apiKey: env.OPENAI_API_KEY!,
        model: env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        system: CURATOR_SYSTEM_PROMPT,
        transcript: text,
        language: "",
        timezone: user.timezone
      });
      replyText = chat.reply;
      raw = { openai: { chat: chat.raw } };
      return true;
    };

    const attempts: Array<() => Promise<boolean>> =
      prefer === "n8n" ? [callN8n, callOpenAI] : prefer === "openai" ? [callOpenAI, callN8n] : [callN8n, callOpenAI];
    try {
      let ok = false;
      for (const fn of attempts) {
        try {
          ok = await fn();
          if (ok) break;
        } catch (e: any) {
          raw = { ...raw, error: true, message: e?.message || String(e) };
        }
      }
      if (!ok) replyText = fallbackCuratorReply(text);
    } catch {
      replyText = fallbackCuratorReply(text);
    }

    await supabaseAdmin.from("voice_transcripts").insert([
      {
        checkin_id: inserted.data.id,
        provider: canUseN8n ? "n8n" : canUseOpenAI ? "openai" : "dm_text",
        transcript: text,
        confidence: null,
        raw,
        reply_text: replyText
      }
    ]);

    // Anti-cheat challenge
    const anti = generateAntiCheat();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    await supabaseAdmin.from("anti_cheat_challenges").insert([
      {
        checkin_id: inserted.data.id,
        user_id: user.id,
        challenge_id: challenge.id,
        question: anti.question,
        answer_int: anti.answer_int,
        attempts: 0,
        status: "pending",
        expires_at_utc: expiresAt
      }
    ]);

    return {
      ok: true,
      checkin: inserted.data,
      reply_text: replyText,
      anti_cheat: { checkin_id: inserted.data.id, question: anti.question, expires_at_utc: expiresAt }
    };
  });

  // POST /bot/anti-cheat/solve
  app.post("/bot/anti-cheat/solve", async (req, reply) => {
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    const checkin_id = String(body.checkin_id || "").trim();
    const answerRaw = String(body.answer || "").trim();
    if (!telegram_user_id || !checkin_id) {
      reply.code(400);
      return { ok: false, error: "invalid_payload" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found", message: "Сначала /start" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge", message: "Сейчас нет активного челленджа" };
    }

    const checkin = await supabaseAdmin.from("checkins").select("*").eq("id", checkin_id).maybeSingle();
    if (!checkin.data || checkin.data.user_id !== userRes.data.id) {
      reply.code(404);
      return { ok: false, error: "checkin_not_found" };
    }
    if (checkin.data.challenge_id !== challenge.id || checkin.data.source !== "voice") {
      reply.code(409);
      return { ok: false, error: "wrong_checkin" };
    }

    const ch = await supabaseAdmin.from("anti_cheat_challenges").select("*").eq("checkin_id", checkin_id).maybeSingle();
    if (!ch.data) {
      reply.code(404);
      return { ok: false, error: "challenge_not_found" };
    }
    if (ch.data.status !== "pending") {
      reply.code(200);
      return { ok: false, error: "not_pending", message: "Эта задачка уже закрыта." };
    }
    if (Date.parse(String(ch.data.expires_at_utc)) <= Date.now()) {
      await supabaseAdmin.from("anti_cheat_challenges").update({ status: "expired" }).eq("id", ch.data.id);
      await supabaseAdmin.from("checkins").update({ status: "rejected", reject_reason: "anticheat_expired" }).eq("id", checkin_id);
      reply.code(200);
      return { ok: false, error: "expired", message: "Время вышло. Напиши новое голосовое, пожалуйста." };
    }

    const ans = Number(answerRaw.replace(/[^\d-]/g, ""));
    if (!Number.isFinite(ans)) {
      reply.code(200);
      return { ok: false, error: "invalid_answer", message: "Ответ должен быть числом." };
    }

    const expected = Number(ch.data.answer_int);
    if (ans !== expected) {
      const attempts = Number(ch.data.attempts || 0) + 1;
      const maxAttempts = 3;
      if (attempts >= maxAttempts) {
        await supabaseAdmin.from("anti_cheat_challenges").update({ attempts, status: "failed" }).eq("id", ch.data.id);
        await supabaseAdmin.from("checkins").update({ status: "rejected", reject_reason: "anticheat_failed" }).eq("id", checkin_id);
        reply.code(200);
        return { ok: false, error: "failed", message: "Ответ неверный. Я передам модератору на проверку." };
      }
      await supabaseAdmin.from("anti_cheat_challenges").update({ attempts }).eq("id", ch.data.id);
      reply.code(200);
      return { ok: false, error: "wrong_answer", message: `Неверно. Попробуй ещё раз (${maxAttempts - attempts} попытки).` };
    }

    await supabaseAdmin.from("anti_cheat_challenges").update({ status: "passed" }).eq("id", ch.data.id);
    await supabaseAdmin.from("checkins").update({ status: "approved", anticheat_passed: true }).eq("id", checkin_id);
    const vt = await supabaseAdmin.from("voice_transcripts").select("reply_text").eq("checkin_id", checkin_id).maybeSingle();
    const replyText = (vt.data as any)?.reply_text || fallbackCuratorReply(null);
    reply.code(200);
    return { ok: true, message: "Засчитано ✅", reply_text: replyText };
  });
}


