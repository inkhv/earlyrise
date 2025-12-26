import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvLocal() {
  // Cursor workspace may block dotfiles; we use env.local instead of .env.
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const envPath = path.resolve(__dirname, "..", "env.local");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const idx = s.indexOf("=");
      if (idx < 0) continue;
      const key = s.slice(0, idx).trim();
      const value = s.slice(idx + 1).trim();
      if (!key) continue;
      if (process.env[key] === undefined && value !== "") {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }
}

loadEnvLocal();

function getLocalParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute")
  };
}

function parseTimeHHMM(input: string): { hour: number; minute: number } | null {
  // Accept "H:MM", "HH:MM", and Postgres time strings like "HH:MM:SS"
  const m = input.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (sec < 0 || sec > 59) return null;
  return { hour, minute };
}

function minutesOfDay(h: number, m: number): number {
  return h * 60 + m;
}

function fmtHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isInWindow(nowMinutes: number, startMinutes: number, windowMinutes: number): boolean {
  // MVP: simple forward window [start, start+window]
  const end = startMinutes + windowMinutes;
  return nowMinutes >= startMinutes && nowMinutes <= end;
}

type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PORT: string;
  N8N_WEBHOOK_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_CHAT_MODEL?: string;
  OPENAI_STT_MODEL?: string;
  OPENAI_PROMPT_ID?: string;
  OPENAI_PROMPT_VERSION?: string;
};

function getEnv(): Env {
  const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }
  return {
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    PORT: process.env.PORT || "3001",
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL?.trim() || undefined,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY?.trim() || undefined,
    OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini",
    OPENAI_STT_MODEL: process.env.OPENAI_STT_MODEL?.trim() || "whisper-1",
    OPENAI_PROMPT_ID: process.env.OPENAI_PROMPT_ID?.trim() || undefined,
    OPENAI_PROMPT_VERSION: process.env.OPENAI_PROMPT_VERSION?.trim() || "1"
  };
}

const env = getEnv();

const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = Fastify({
  logger: {
    level: "info"
  }
});

await app.register(cors, { origin: true });

app.get("/health", async () => {
  return { ok: true, service: "earlyrise-api", ts: new Date().toISOString() };
});

const CURATOR_SYSTEM_PROMPT = [
  "Ты — наставник/куратор по ранним подъёмам.",
  "Участник не ведёт переписку: он отправляет голосовой отчёт и получает один ответ.",
  "Твоя цель — мягко поддержать и помочь прийти к 80% подъёмов в нужное время (стабильность важнее идеальности).",
  "",
  "Правила ответа:",
  "- Русский язык, тон тёплый и спокойный, без мотивационных лозунгов.",
  "- 5–10 коротких предложений (1–2 абзаца).",
  "- Структура: отражение/перефраз → сильные стороны → зона роста → 1 микро‑шаг на завтра → напоминание про цель 80%.",
  "- Если планов нет: предложи в следующий раз ответить на 2 вопроса: (1) что делаю в первые 10 минут? (2) какой 1 результат до ближайшего часа?"
].join("\n");

async function postJson(url: string, body: unknown, timeoutMs = 25000): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

async function openaiTranscribe(params: { apiKey: string; model: string; audioBytes: Uint8Array; mime: string }): Promise<{ transcript: string; raw: any }> {
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
      "Принял твоё голосовое. Главное — ты зафиксировал подъём, это уже шаг к стабильности.",
      "Сильная сторона — ты отмечаешь прогресс и не “сливаешь” утро.",
      "На завтра попробуй добавить немного конкретики: что ты сделаешь в первые 10 минут после подъёма и какой один результат хочешь получить в течение ближайшего часа.",
      "Мы идём к цели спокойно: 80% подъёмов в нужное время — это и есть победа."
    ].join(" ");
  }
  return [
    "Принял твоё голосовое — спасибо за конкретику.",
    "Сильная сторона — ты замечаешь, что у тебя получилось, и формулируешь намерение на утро.",
    "Аккуратно про зону роста: выбери один самый маленький первый шаг (на 10–20 минут), чтобы утро не расплывалось.",
    "На завтра: назови один конкретный результат до ближайшего часа после подъёма.",
    "Двигаемся к 80% подъёмов в нужное время — без давления, шаг за шагом."
  ].join(" ");
}

// --- Admin auth (MVP) ---
// Web sends Supabase access token in Authorization: Bearer <jwt>
async function requireAdmin(request: any) {
  const authHeader: string | undefined = request.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.email) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  const email = data.user.email;
  const adminRow = await supabaseAdmin.from("admins").select("email").eq("email", email).maybeSingle();
  if (!adminRow.data) {
    const err: any = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
  return { email };
}

// GET /admin/settings (global)
app.get("/admin/settings", async (req) => {
  await requireAdmin(req);
  const row = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
  return { settings: row.data };
});

// GET /admin/users (CSV optional)
app.get("/admin/users", async (req, reply) => {
  await requireAdmin(req);
  const format = (req.query as any)?.format;
  const q = (req.query as any)?.q?.toString().trim();
  let query = supabaseAdmin.from("user_stats").select("*").order("created_at", { ascending: false } as any);
  // user_stats is a view; created_at not present. Keep order on telegram_user_id for MVP.
  query = supabaseAdmin.from("user_stats").select("*").order("telegram_user_id", { ascending: false });
  if (q) {
    // simple filter: username ilike
    query = query.ilike("username", `%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw error;

  if (format === "csv") {
    const rows = data || [];
    const header = ["telegram_user_id", "username", "first_name", "timezone", "streak_days", "total_checkins", "last_checkin_at_utc"];
    const lines = [header.join(",")].concat(
      rows.map((r: any) =>
        [
          r.telegram_user_id,
          JSON.stringify(r.username || ""),
          JSON.stringify(r.first_name || ""),
          JSON.stringify(r.timezone || ""),
          r.streak_days ?? 0,
          r.total_checkins ?? 0,
          JSON.stringify(r.last_checkin_at_utc || "")
        ].join(",")
      )
    );
    reply.header("Content-Type", "text/csv; charset=utf-8");
    return lines.join("\n");
  }

  return { users: data || [] };
});

// GET /admin/users/:id
app.get("/admin/users/:id", async (req) => {
  await requireAdmin(req);
  const id = (req.params as any).id as string;
  const user = await supabaseAdmin.from("users").select("*").eq("id", id).single();
  const stats = await supabaseAdmin.from("user_stats").select("*").eq("user_id", id).maybeSingle();
  const checkins = await supabaseAdmin.from("checkins").select("*").eq("user_id", id).order("checkin_at_utc", { ascending: false }).limit(200);
  const parts = await supabaseAdmin.from("participations").select("*, challenges(*)").eq("user_id", id).order("joined_at", { ascending: false });
  const payments = await supabaseAdmin.from("payments").select("*").eq("user_id", id).order("created_at", { ascending: false });
  const ledger = await supabaseAdmin.from("wallet_ledger").select("*").eq("user_id", id).order("created_at", { ascending: false });
  const balance = (ledger.data || []).reduce((acc: number, x: any) => acc + Number(x.delta || 0), 0);
  return {
    user: user.data,
    stats: stats.data,
    checkins: checkins.data || [],
    participations: parts.data || [],
    payments: payments.data || [],
    wallet: { balance, ledger: ledger.data || [] }
  };
});

// POST /admin/settings (global only for MVP)
app.post("/admin/settings", async (req) => {
  await requireAdmin(req);
  const body = (req.body || {}) as any;
  const { data: existing } = await supabaseAdmin.from("settings").select("*").eq("scope", "global").maybeSingle();
  if (!existing) {
    const inserted = await supabaseAdmin.from("settings").insert([{ scope: "global", ...body }]).select("*").single();
    return { settings: inserted.data };
  }
  const updated = await supabaseAdmin.from("settings").update(body).eq("id", existing.id).select("*").single();
  return { settings: updated.data };
});

// POST /payments/webhook (stub)
app.post("/payments/webhook", async () => {
  return { ok: true, stub: true };
});

// --- Bot-facing endpoints (thin; bot should not touch DB directly) ---
app.post("/bot/upsert-user", async (req) => {
  const body = req.body as any;
  const telegram_user_id = Number(body.telegram_user_id);
  const username = body.username ?? null;
  const first_name = body.first_name ?? null;

  const existing = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
  if (existing.data) {
    const updated = await supabaseAdmin
      .from("users")
      .update({ username, first_name })
      .eq("id", existing.data.id)
      .select("*")
      .single();
    return { user: updated.data };
  }
  const inserted = await supabaseAdmin
    .from("users")
    .insert([{ telegram_user_id, username, first_name }])
    .select("*")
    .single();
  return { user: inserted.data };
});

app.post("/bot/set-timezone", async (req) => {
  const body = req.body as any;
  const telegram_user_id = Number(body.telegram_user_id);
  const timezone = String(body.timezone || "").trim();
  const updated = await supabaseAdmin
    .from("users")
    .update({ timezone })
    .eq("telegram_user_id", telegram_user_id)
    .select("*")
    .single();
  return { user: updated.data };
});

app.get("/bot/me/:telegramUserId", async (req) => {
  const telegramUserId = Number((req.params as any).telegramUserId);
  const user = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (!user.data) return { user: null };
  const stats = await supabaseAdmin.from("user_stats").select("*").eq("user_id", user.data.id).maybeSingle();
  return { user: user.data, stats: stats.data };
});

async function getActiveChallenge() {
  const res = await supabaseAdmin.from("challenges").select("*").eq("status", "active").order("created_at", { ascending: false }).limit(1);
  return res.data?.[0] ?? null;
}

async function ensureUser(telegram_user_id: number, opts?: { username?: string | null; first_name?: string | null }) {
  const existing = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
  if (existing.data) {
    // opportunistic update
    const username = opts?.username ?? existing.data.username ?? null;
    const first_name = opts?.first_name ?? existing.data.first_name ?? null;
    if (username !== existing.data.username || first_name !== existing.data.first_name) {
      const updated = await supabaseAdmin
        .from("users")
        .update({ username, first_name })
        .eq("id", existing.data.id)
        .select("*")
        .single();
      return updated.data;
    }
    return existing.data;
  }
  const inserted = await supabaseAdmin
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

// POST /bot/join
// body: { telegram_user_id: number, wake_time_local: "HH:MM" }
app.post("/bot/join", async (req, reply) => {
  const body = req.body as any;
  const telegram_user_id = Number(body.telegram_user_id);
  const wakeStr = String(body.wake_time_local || "").trim();
  const parsed = parseTimeHHMM(wakeStr);
  if (!parsed) {
    reply.code(400);
    return { ok: false, error: "invalid_wake_time", message: "wake_time_local должен быть в формате HH:MM" };
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

  // Compute wake_utc_minutes (MVP approximation): use current timezone offset by comparing local parts to UTC.
  const tz = userRes.data.timezone || "Europe/Amsterdam";
  const now = new Date();
  const local = getLocalParts(now, tz);
  const localNowUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0));
  const offsetMinutes = Math.round((localNowUtc.getTime() - now.getTime()) / 60000); // local - utc in minutes
  const wakeLocalMinutes = minutesOfDay(parsed.hour, parsed.minute);
  const wakeUtcMinutes = (wakeLocalMinutes - offsetMinutes + 1440) % 1440;

  // ensure participation exists
  const existing = await supabaseAdmin
    .from("participations")
    .select("*")
    .eq("user_id", userRes.data.id)
    .eq("challenge_id", challenge.id)
    .maybeSingle();

  if (existing.data && !existing.data.left_at) {
    // update wake time (allowed)
    const upd = await supabaseAdmin
      .from("participations")
      .update({ wake_time_local: wakeStr, wake_utc_minutes: wakeUtcMinutes })
      .eq("id", existing.data.id)
      .select("*")
      .single();
    return { ok: true, participation: upd.data, challenge };
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
          wake_time_local: wakeStr,
          wake_utc_minutes: wakeUtcMinutes
        }
      ],
      { onConflict: "user_id,challenge_id" }
    )
    .select("*")
    .single();

  return { ok: true, participation: inserted.data, challenge };
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

  const partRes = await supabaseAdmin
    .from("participations")
    .select("*")
    .eq("user_id", userRes.data.id)
    .eq("challenge_id", challenge.id)
    .maybeSingle();
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

  const tz = userRes.data.timezone || "Europe/Amsterdam";
  const now = new Date();
  const localNow = getLocalParts(now, tz);
  const nowMinutes = minutesOfDay(localNow.hour, localNow.minute);
  const wakeMinutes = minutesOfDay(parsedWake.hour, parsedWake.minute);
  const window = Number(settings.data.checkin_window_minutes || 30);

  if (!isInWindow(nowMinutes, wakeMinutes, window)) {
    // record rejected checkin (optional; for MVP we record rejected too)
    const inserted = await supabaseAdmin.from("checkins").insert([
      {
        user_id: userRes.data.id,
        challenge_id: challenge.id,
        checkin_at_utc: now.toISOString(),
        source: "text",
        status: "rejected",
        reject_reason: "outside_window",
        raw_text: text
      }
    ]).select("*").single();
    reply.code(200);
    const endMinutes = wakeMinutes + window;
    return {
      ok: false,
      error: "outside_window",
      message: `Окно чек-ина (${tz}): ${fmtHHMM(wakeMinutes)}–${fmtHHMM(endMinutes)}. Сейчас: ${fmtHHMM(nowMinutes)}.`,
      checkin: inserted.data
    };
  }

  const inserted = await supabaseAdmin.from("checkins").insert([
    {
      user_id: userRes.data.id,
      challenge_id: challenge.id,
      checkin_at_utc: now.toISOString(),
      source: "text",
      status: "approved",
      raw_text: text
    }
  ]).select("*").single();

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

  // auto-upsert user + participation for "continuous flow"
  const user = await ensureUser(telegram_user_id, { username: body.username ?? null, first_name: body.first_name ?? null });
  await ensureParticipation(user.id, challenge.id);

  const meta = {
    kind: "group_plus",
    chat_id: typeof body.chat_id === "number" ? body.chat_id : undefined,
    message_id: typeof body.message_id === "number" ? body.message_id : undefined,
    text
  };

  const inserted = await supabaseAdmin.from("checkins").insert([
    {
      user_id: user.id,
      challenge_id: challenge.id,
      checkin_at_utc: new Date().toISOString(),
      source: "text",
      status: "approved",
      raw_text: JSON.stringify(meta)
    }
  ]).select("*").single();

  return { ok: true, checkin: inserted.data };
});

// POST /bot/checkin/voice (MVP: record voice as check-in; transcript optional)
// body: {
//   telegram_user_id: number,
//   file_id: string,
//   duration?: number,
//   chat_id?: number,
//   message_id?: number,
//   username?: string|null,
//   first_name?: string|null,
//   audio_base64?: string,      // optional: OGG/Opus bytes
//   audio_mime?: string         // optional, default audio/ogg
// }
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

  const meta = {
    kind: "voice",
    chat_id: typeof body.chat_id === "number" ? body.chat_id : undefined,
    message_id: typeof body.message_id === "number" ? body.message_id : undefined,
    file_id,
    duration: Number.isFinite(duration) ? duration : undefined
  };

  const inserted = await supabaseAdmin.from("checkins").insert([
    {
      user_id: user.id,
      challenge_id: challenge.id,
      checkin_at_utc: new Date().toISOString(),
      source: "voice",
      status: "approved",
      raw_text: JSON.stringify(meta)
    }
  ]).select("*").single();

  // Voice transcript + curator feedback
  let transcript: string | null = null;
  let confidence: number | null = null;
  let replyText: string | null = null;
  let raw: any = { skipped: true, reason: "mvp_no_n8n" };

  const voiceEnabled = settings.data.voice_feedback_enabled !== false;
  if (!voiceEnabled) {
    replyText = "Принял голосовое. (Сейчас фидбек по голосу отключён в настройках.)";
  } else if (env.OPENAI_API_KEY && audio_base64) {
    try {
      const audioBytes = new Uint8Array(Buffer.from(audio_base64, "base64"));
      const stt = await openaiTranscribe({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_STT_MODEL || "whisper-1",
        audioBytes,
        mime: audio_mime || "audio/ogg"
      });
      transcript = stt.transcript || null;
      confidence = null;
      const chat = await openaiCuratorReply({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        system: CURATOR_SYSTEM_PROMPT,
        transcript: transcript || "",
        language: "", // prompt may auto-detect; keep empty for now
        timezone: user.timezone
      });
      replyText = chat.reply;
      raw = { stt: stt.raw, chat: chat.raw };
    } catch (e: any) {
      raw = { error: true, message: e?.message || String(e) };
      replyText = fallbackCuratorReply(null);
    }
  } else {
    // No OpenAI key/audio: still provide fallback
    replyText = fallbackCuratorReply(null);
  }

  await supabaseAdmin.from("voice_transcripts").insert([
    {
      checkin_id: inserted.data.id,
      provider: env.OPENAI_API_KEY ? "openai" : "mvp",
      transcript,
      confidence,
      raw
    }
  ]);

  return { ok: true, checkin: inserted.data, reply_text: replyText, transcript, confidence };
});

const port = Number(env.PORT || 3001);
await app.listen({ port, host: "0.0.0.0" });






