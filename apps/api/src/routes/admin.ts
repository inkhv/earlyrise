import type { FastifyInstance } from "fastify";
import { env, supabaseAdmin } from "../config.js";
import { cleanupVoiceStorage } from "../services/storage.js";
import { getActiveChallenge, type AccessStatus, isAllowedWakeTime } from "../services/challenge.js";
import { getLocalParts, minutesOfDay, normalizeTimezoneToStore, parseGmtOffsetToMinutes, parseTimeHHMM, utcRangeForLocalDay } from "../utils/time.js";

const ANNOUNCEMENT_TEXT =
  "Привет! Я бот EarlyRise — запускаем тест утреннего челленджа.\n\n" +
  "Чтобы подключиться:\n" +
  "1) Откройте мой профиль и нажмите /start (в личке).\n" +
  "2) Установите часовой пояс: /settz GMT+3\n" +
  "   (или отправьте геопозицию после команды /settz).\n" +
  "3) Выберите режим подъёма:\n" +
  "   - фиксированный: /join 05:00 / 06:00 / 07:00 / 08:00 / 09:00\n" +
  "   - без точного времени: /join flex\n\n" +
  "Дальше каждое утро:\n" +
  "- в общем чате ставим +\n" +
  "- в личку боту отправляем голосовое с планами на утро и отвечаем на короткую задачку.";

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

async function requireDashboard(request: any) {
  // Prefer simple shared token (MVP) to avoid building full auth UI.
  // If ADMIN_DASHBOARD_TOKEN is set, accept via header x-admin-token or query ?token=...
  const token = env.ADMIN_DASHBOARD_TOKEN;
  if (token) {
    const header = (request.headers["x-admin-token"] || request.headers["x-admin-token".toLowerCase()]) as string | undefined;
    const qToken = (request.query as any)?.token?.toString();
    if (header === token || qToken === token) return { mode: "token" as const };
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  // Fallback to Supabase admin JWT (existing)
  await requireAdmin(request);
  return { mode: "supabase" as const };
}

function toIsoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseHHMMToMinutes(input: string): number | null {
  const t = parseTimeHHMM(input);
  if (!t) return null;
  return minutesOfDay(t.hour, t.minute);
}

function daterangeUtcDays(params: { days?: number; start?: string; end?: string }): { dates: string[]; startIso: string; endIso: string } {
  const days = Number.isFinite(params.days) && (params.days as number) > 0 ? Math.min(60, Math.floor(params.days as number)) : 14;
  const today = new Date();
  const endDay = params.end ? new Date(`${params.end}T00:00:00.000Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0));
  const startDay = params.start ? new Date(`${params.start}T00:00:00.000Z`) : new Date(endDay.getTime() - (days - 1) * 86400000);
  const dates: string[] = [];
  for (let t = startDay.getTime(); t <= endDay.getTime(); t += 86400000) {
    dates.push(toIsoDateUTC(new Date(t)));
  }
  const startIso = `${dates[0]}T00:00:00.000Z`;
  const endIso = `${dates[dates.length - 1]}T23:59:59.999Z`;
  return { dates, startIso, endIso };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function telegramSendMessage(params: { chat_id: number | string; text: string; reply_markup?: any }) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    const err: any = new Error("Telegram bot token is not configured on API");
    err.statusCode = 501;
    throw err;
  }
  const payload = {
    chat_id: params.chat_id,
    text: params.text,
    disable_web_page_preview: true,
    reply_markup: params.reply_markup
  };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.ok === false) {
    const err: any = new Error(`Telegram sendMessage failed: ${res.status}`);
    err.statusCode = 502;
    err.details = json;
    throw err;
  }
  return json;
}

async function telegramBanChatMember(params: { chat_id: number | string; user_id: number; until_date?: number }) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    const err: any = new Error("Telegram bot token is not configured on API");
    err.statusCode = 501;
    throw err;
  }
  const payload: any = {
    chat_id: params.chat_id,
    user_id: params.user_id,
    revoke_messages: false
  };
  if (Number.isFinite(params.until_date)) payload.until_date = params.until_date;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/banChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.ok === false) {
    const err: any = new Error(`Telegram banChatMember failed: ${res.status}`);
    err.statusCode = 502;
    err.details = json;
    throw err;
  }
  return json;
}

async function telegramUnbanChatMember(params: { chat_id: number | string; user_id: number }) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    const err: any = new Error("Telegram bot token is not configured on API");
    err.statusCode = 501;
    throw err;
  }
  const payload: any = {
    chat_id: params.chat_id,
    user_id: params.user_id,
    only_if_banned: true
  };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/unbanChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.ok === false) {
    const err: any = new Error(`Telegram unbanChatMember failed: ${res.status}`);
    err.statusCode = 502;
    err.details = json;
    throw err;
  }
  return json;
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingColumnError(e: any, column: string): boolean {
  const msg = String(e?.message || e?.details || e || "");
  return /column .* does not exist/i.test(msg) && msg.toLowerCase().includes(column.toLowerCase());
}

// --- Buddy admin (MVP) ---
async function getActiveParticipationId(user_id: string, challenge_id: string): Promise<string | null> {
  const res = await supabaseAdmin
    .from("participations")
    .select("id")
    .eq("user_id", user_id)
    .eq("challenge_id", challenge_id)
    .is("left_at", null)
    .limit(1);
  if (res.error) throw res.error;
  return res.data?.[0]?.id ? String(res.data[0].id) : null;
}

async function getBuddyUserForParticipation(params: {
  challenge_id: string;
  participation_id: string;
}): Promise<{ pairId: string; buddyParticipationId: string } | null> {
  const { challenge_id, participation_id } = params;
  const res = await supabaseAdmin
    .from("buddy_pairs")
    .select("id, participation_a_id, participation_b_id, status")
    .eq("challenge_id", challenge_id)
    .eq("status", "active")
    .or(`participation_a_id.eq.${participation_id},participation_b_id.eq.${participation_id}`)
    .limit(1);
  if (res.error) throw res.error;
  const row: any = res.data?.[0];
  if (!row?.id) return null;
  const a = String(row.participation_a_id);
  const b = String(row.participation_b_id);
  const buddyParticipationId = participation_id === a ? b : a;
  return { pairId: String(row.id), buddyParticipationId };
}

export function registerAdminRoutes(app: FastifyInstance) {
  // GET /admin/dashboard (simple HTML UI)
  app.get("/admin/dashboard", async (req, reply) => {
    // allow page itself without auth; data endpoint is protected
    const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>EarlyRise Admin Dashboard</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 0; background: #0b1220; color: #e5e7eb; }
      .wrap { padding: 16px; max-width: 1400px; margin: 0 auto; }
      .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 12px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
      label { font-size: 12px; color: #9ca3af; display:block; margin-bottom: 6px; }
      input { background: #0b1220; border: 1px solid #334155; color: #e5e7eb; border-radius: 8px; padding: 8px 10px; min-width: 140px; }
      button { background: #2563eb; border: 0; color: white; border-radius: 10px; padding: 9px 12px; cursor: pointer; }
      button:disabled { background: #334155; cursor: not-allowed; }
      .hint { color: #9ca3af; font-size: 12px; margin-top: 6px; }
      .grid { overflow: auto; border: 1px solid #1f2937; border-radius: 12px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #1f2937; padding: 8px 10px; font-size: 12px; white-space: nowrap; }
      th { position: sticky; top: 0; background: #0f172a; z-index: 2; text-align: left; }
      td.sticky, th.sticky { position: sticky; left: 0; background: #0f172a; z-index: 3; }
      td.plus { color: #34d399; font-weight: 700; }
      td.minus { color: #f87171; font-weight: 700; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      textarea { background: #0b1220; border: 1px solid #334155; color: #e5e7eb; border-radius: 8px; padding: 8px 10px; width: min(900px, 100%); min-height: 120px; }
      .modalBack { position: fixed; inset: 0; background: rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; padding: 18px; }
      .modal { width: min(920px, 100%); background: #0f172a; border: 1px solid #1f2937; border-radius: 14px; padding: 14px; }
      .modalHeader { display:flex; justify-content:space-between; align-items:center; gap: 12px; }
      .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; background:#111827; border:1px solid #1f2937; font-size:12px; color:#9ca3af; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h2 style="margin: 4px 0 12px 0;">EarlyRise — Admin Dashboard</h2>
      <div class="card">
        <div class="row">
          <div>
            <label>Admin token (MVP)</label>
            <input id="token" placeholder="ADMIN_DASHBOARD_TOKEN" />
            <div class="hint">Если токен не задан на сервере, потребуется Supabase admin JWT (пока не поддержан в этой странице).</div>
          </div>
          <div>
            <label>Days</label>
            <input id="days" class="mono" value="14" />
          </div>
          <div>
            <label>Wake from (HH:MM)</label>
            <input id="wakeFrom" class="mono" placeholder="06:00" />
          </div>
          <div>
            <label>Wake to (HH:MM)</label>
            <input id="wakeTo" class="mono" placeholder="09:00" />
          </div>
          <div>
            <button id="load">Load</button>
          </div>
          <div>
            <button id="openBroadcast" style="background:#10b981;">Broadcast</button>
          </div>
        </div>
      </div>

      <div style="height: 12px"></div>

      <div class="card">
        <div style="font-weight:700;">Анонс / рассылка в чат</div>
        <div class="hint">Вставь chat_id группы (можно узнать командой /chatid в группе) и нажми отправить. Доступно только при наличии admin token.</div>
        <div style="height: 10px"></div>
        <div class="row">
          <div>
            <label>chat_id</label>
            <input id="broadcastChatId" class="mono" placeholder="-1001234567890" />
          </div>
          <div style="flex: 1; min-width: 260px;">
            <label>Текст</label>
            <input id="broadcastText" style="min-width: 420px; width: min(900px, 100%);" />
          </div>
          <div>
            <button id="broadcastSend">Send</button>
          </div>
        </div>
        <div class="hint" id="broadcastStatus"></div>
      </div>

      <div style="height: 12px"></div>

      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:700;">Участники</div>
            <div class="hint" id="meta"></div>
          </div>
        </div>
        <div style="height: 10px"></div>
        <div class="grid" id="participants"></div>
      </div>

      <div style="height: 12px"></div>

      <div class="card">
        <div style="font-weight:700;">Сводка по отметкам (+/-) из чата</div>
        <div class="hint">Колонки — даты (UTC), строки — участники. “+” если есть отметка в чате в этот день, иначе “-”.</div>
        <div style="height: 10px"></div>
        <div class="grid" id="matrix"></div>
      </div>
    </div>

    <!-- Broadcast modal -->
    <div class="modalBack" id="broadcastModalBack">
      <div class="modal">
        <div class="modalHeader">
          <div>
            <div style="font-weight:800;">Broadcast</div>
            <div class="hint">Отправка сообщений через админку <span class="pill">admin token required</span></div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button id="broadcastClose" style="background:#334155;">Закрыть</button>
          </div>
        </div>
        <div style="height: 10px"></div>
        <div class="card" style="background:#111827;">
          <div class="row" style="align-items:start;">
            <div style="min-width:240px;">
              <label>Куда отправить</label>
              <div style="display:grid; gap:6px; font-size:13px;">
                <label style="margin:0; color:#e5e7eb;"><input type="radio" name="bTarget" value="group" checked /> в общий чат (по chat_id)</label>
                <label style="margin:0; color:#e5e7eb;"><input type="radio" name="bTarget" value="paid" /> всем пользователям paid</label>
                <label style="margin:0; color:#e5e7eb;"><input type="radio" name="bTarget" value="lead" /> всем пользователям lead</label>
                <label style="margin:0; color:#e5e7eb;"><input type="radio" name="bTarget" value="user" /> лично пользователю (по @username)</label>
              </div>
              <div class="hint">paid/lead — по активному челленджу среди активных участников.</div>
            </div>
            <div style="flex:1; min-width:260px;">
              <div class="row">
                <div>
                  <label>chat_id (для общего чата)</label>
                  <input id="bChatId" class="mono" placeholder="-1001234567890" />
                </div>
                <div>
                  <label>@username (для личного)</label>
                  <input id="bUsername" class="mono" placeholder="@username" />
                </div>
              </div>
              <div style="height: 8px"></div>
              <label>Сообщение</label>
              <textarea id="bText"></textarea>
              <div class="row" style="margin-top:8px;">
                <button id="bSend">Send</button>
                <button id="bUseAnnouncement" style="background:#2563eb;">Вставить шаблон анонса</button>
              </div>
              <div class="hint" id="bStatus"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const tokenEl = document.getElementById('token');
      const daysEl = document.getElementById('days');
      const wakeFromEl = document.getElementById('wakeFrom');
      const wakeToEl = document.getElementById('wakeTo');
      const loadBtn = document.getElementById('load');
      const openBroadcastBtn = document.getElementById('openBroadcast');
      const participantsEl = document.getElementById('participants');
      const matrixEl = document.getElementById('matrix');
      const metaEl = document.getElementById('meta');
      const broadcastChatIdEl = document.getElementById('broadcastChatId');
      const broadcastTextEl = document.getElementById('broadcastText');
      const broadcastSendBtn = document.getElementById('broadcastSend');
      const broadcastStatusEl = document.getElementById('broadcastStatus');

      tokenEl.value = localStorage.getItem('er_admin_token') || '';
      broadcastChatIdEl.value = localStorage.getItem('er_broadcast_chat_id') || '';
      broadcastTextEl.value = ${JSON.stringify(ANNOUNCEMENT_TEXT)};

      // Modal elements
      const modalBack = document.getElementById('broadcastModalBack');
      const modalClose = document.getElementById('broadcastClose');
      const bChatId = document.getElementById('bChatId');
      const bUsername = document.getElementById('bUsername');
      const bText = document.getElementById('bText');
      const bSend = document.getElementById('bSend');
      const bUseAnnouncement = document.getElementById('bUseAnnouncement');
      const bStatus = document.getElementById('bStatus');

      bChatId.value = localStorage.getItem('er_broadcast_chat_id') || '';
      bText.value = localStorage.getItem('er_broadcast_text') || ${JSON.stringify(ANNOUNCEMENT_TEXT)};

      function openModal() {
        modalBack.style.display = 'flex';
        bStatus.textContent = '';
        // Auto-detect recent chat_ids (best-effort)
        (async () => {
          try {
            const token = tokenEl.value.trim();
            if (!token) return;
            const res = await fetch('/admin/chat-ids/recent?limit=300', { headers: { 'x-admin-token': token } });
            const t = await res.text();
            let j = null;
            try { j = JSON.parse(t); } catch { j = null; }
            if (!res.ok || !j?.ok || !Array.isArray(j.items)) return;
            if (!bChatId.value.trim() && j.items[0]?.chat_id) {
              bChatId.value = String(j.items[0].chat_id);
              localStorage.setItem('er_broadcast_chat_id', String(j.items[0].chat_id));
            }
          } catch {}
        })();
      }
      function closeModal() {
        modalBack.style.display = 'none';
      }
      openBroadcastBtn.addEventListener('click', openModal);
      modalClose.addEventListener('click', closeModal);
      modalBack.addEventListener('click', (e) => { if (e.target === modalBack) closeModal(); });

      function selectedTarget() {
        const el = document.querySelector('input[name="bTarget"]:checked');
        return el ? el.value : 'group';
      }

      async function sendBroadcastModal() {
        bSend.disabled = true;
        bStatus.textContent = 'Sending...';
        try {
          const token = tokenEl.value.trim();
          if (!token) throw new Error('Нужен admin token');
          const target = selectedTarget();
          const text = (bText.value || '').toString();
          if (!text.trim()) throw new Error('Текст пустой');
          localStorage.setItem('er_broadcast_text', text);
          const payload = { target, text };
          if (target === 'group') {
            const chatId = bChatId.value.trim();
            if (!chatId) throw new Error('Нужен chat_id');
            localStorage.setItem('er_broadcast_chat_id', chatId);
            payload.chat_id = chatId;
          } else if (target === 'user') {
            const u = bUsername.value.trim();
            if (!u) throw new Error('Нужен @username');
            payload.username = u;
          }
          const res = await fetch('/admin/broadcast/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
            body: JSON.stringify(payload)
          });
          const t = await res.text();
          let j = null;
          try { j = JSON.parse(t); } catch { j = { raw: t }; }
          if (!res.ok) throw new Error(j?.message || j?.error || ('HTTP ' + res.status));
          const summary = j && typeof j === 'object' ? ('OK ✅  sent=' + (j.sent||0) + ' failed=' + (j.failed||0) + ' attempted=' + (j.attempted||0)) : 'OK ✅';
          bStatus.textContent = summary;
        } catch (e) {
          bStatus.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        } finally {
          bSend.disabled = false;
        }
      }
      bSend.addEventListener('click', sendBroadcastModal);
      bUseAnnouncement.addEventListener('click', () => {
        bText.value = ${JSON.stringify(ANNOUNCEMENT_TEXT)};
      });

      async function sendBroadcast() {
        broadcastSendBtn.disabled = true;
        broadcastStatusEl.textContent = 'Sending...';
        try {
          const token = tokenEl.value.trim();
          if (!token) throw new Error('Нужен admin token');
          const chatId = broadcastChatIdEl.value.trim();
          if (!chatId) throw new Error('Нужен chat_id');
          localStorage.setItem('er_broadcast_chat_id', chatId);
          const text = broadcastTextEl.value || '';
          if (!text.trim()) throw new Error('Текст пустой');

          const res = await fetch('/admin/broadcast/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
            body: JSON.stringify({ chat_id: chatId, text })
          });
          const t = await res.text();
          let j = null;
          try { j = JSON.parse(t); } catch { j = { raw: t }; }
          if (!res.ok) throw new Error(j?.message || j?.error || ('HTTP ' + res.status));
          broadcastStatusEl.textContent = 'OK: отправлено ✅';
        } catch (e) {
          broadcastStatusEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        } finally {
          broadcastSendBtn.disabled = false;
        }
      }

      async function load() {
        loadBtn.disabled = true;
        participantsEl.innerHTML = '';
        matrixEl.innerHTML = '';
        metaEl.textContent = 'Loading...';
        try {
          const token = tokenEl.value.trim();
          localStorage.setItem('er_admin_token', token);
          const params = new URLSearchParams();
          if (daysEl.value.trim()) params.set('days', daysEl.value.trim());
          if (wakeFromEl.value.trim()) params.set('wake_from', wakeFromEl.value.trim());
          if (wakeToEl.value.trim()) params.set('wake_to', wakeToEl.value.trim());
          const res = await fetch('/admin/dashboard/data?' + params.toString(), {
            headers: token ? { 'x-admin-token': token } : {}
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { throw new Error(text || ('HTTP ' + res.status)); }
          if (!res.ok) throw new Error(json?.message || json?.error || ('HTTP ' + res.status));

          metaEl.textContent = (json.challenge?.title ? ('Челлендж: ' + json.challenge.title + ' · ') : '') +
            ('Участников: ' + json.participants.length + ' · Даты: ' + json.dates[0] + ' → ' + json.dates[json.dates.length-1]);

          // Participants table
          const pRows = json.participants.map(p => {
            const name = p.display_name || ('#' + p.telegram_user_id);
            const token = (tokenEl.value || '').trim();
            const href = '/admin/user/' + encodeURIComponent(p.user_id) + (token ? ('?token=' + encodeURIComponent(token)) : '');
            const buddy = p.buddy_display_name || '';
            const status = p.access_status || 'lead';
            const statusLabel = status === 'paid' ? 'paid' : status === 'trial' ? 'trial' : 'lead';
            const trialUntil = p.trial_until_utc ? String(p.trial_until_utc).slice(0, 10) : '';
            return '<tr>' +
              '<td class="sticky"><a href="' + href + '" style="color:#93c5fd; text-decoration:none;">' + name + '</a></td>' +
              '<td class="mono">' + (p.wake_time_local || '') + '</td>' +
              '<td class="mono">' + (p.timezone || '') + '</td>' +
              '<td>' + buddy + '</td>' +
              '<td class="mono">' + statusLabel + (trialUntil ? (' до ' + trialUntil) : '') + '</td>' +
              '</tr>';
          }).join('');
          participantsEl.innerHTML = '<table><thead><tr><th class="sticky">Имя</th><th>Wake</th><th>Timezone</th><th>Напарник</th><th>Доступ</th></tr></thead><tbody>' + pRows + '</tbody></table>';

          // Matrix table
          const headDates = json.dates.map(d => '<th class="mono">' + d.slice(5) + '</th>').join('');
          const mRows = json.matrix.map(r => {
            const cells = json.dates.map(d => {
              const v = r.marks[d] || '-';
              const cls = v === '+' ? 'plus' : 'minus';
              return '<td class="' + cls + '">' + v + '</td>';
            }).join('');
            return '<tr><td class="sticky">' + (r.display_name || '') + '</td>' + cells + '</tr>';
          }).join('');
          matrixEl.innerHTML = '<table><thead><tr><th class="sticky">Участник</th>' + headDates + '</tr></thead><tbody>' + mRows + '</tbody></table>';
        } catch (e) {
          metaEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        } finally {
          loadBtn.disabled = false;
        }
      }

      loadBtn.addEventListener('click', load);
      broadcastSendBtn.addEventListener('click', sendBroadcast);
    </script>
  </body>
</html>`;
    reply.header("Content-Type", "text/html; charset=utf-8");
    return html;
  });

  // POST /admin/broadcast/telegram
  // body: { chat_id: string|number, text: string }
  app.post("/admin/broadcast/telegram", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const chat_id_raw = body.chat_id;
    const text = String(body.text || "");
    if (!text.trim()) {
      reply.code(400);
      return { ok: false, error: "empty_text" };
    }
    const chat_id_str = String(chat_id_raw ?? "").trim();
    if (!chat_id_str) {
      reply.code(400);
      return { ok: false, error: "missing_chat_id" };
    }
    // Telegram group IDs can be negative; keep as string but validate numeric-ish
    if (!/^-?\d+$/.test(chat_id_str)) {
      reply.code(400);
      return { ok: false, error: "invalid_chat_id", message: "chat_id должен быть числом (например -100...)" };
    }
    const tg = await telegramSendMessage({ chat_id: chat_id_str, text });
    return { ok: true, result: tg?.result || null };
  });

  // POST /admin/broadcast/send
  // body:
  // - { target: "group", chat_id: string|number, text: string }
  // - { target: "paid"|"lead", text: string }
  // - { target: "user", username: string, text: string }
  //
  // Notes:
  // - paid/lead selection is computed for ACTIVE challenge among active participations (left_at is null)
  // - lead means: not paid and not active trial (trial users excluded)
  app.post("/admin/broadcast/send", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const target = String(body.target || "").trim();
    const text = String(body.text || "");
    if (!text.trim()) {
      reply.code(400);
      return { ok: false, error: "empty_text" };
    }

    const sendDm = async (telegram_user_id: number) => {
      return await telegramSendMessage({ chat_id: telegram_user_id, text });
    };

    if (target === "group") {
      const chat_id_str = String(body.chat_id ?? "").trim();
      if (!chat_id_str) {
        reply.code(400);
        return { ok: false, error: "missing_chat_id" };
      }
      if (!/^-?\d+$/.test(chat_id_str)) {
        reply.code(400);
        return { ok: false, error: "invalid_chat_id", message: "chat_id должен быть числом (например -100...)" };
      }
      const tg = await telegramSendMessage({ chat_id: chat_id_str, text });
      return { ok: true, target, attempted: 1, sent: 1, failed: 0, result: tg?.result || null };
    }

    if (target === "user") {
      const raw = String(body.username || "").trim();
      if (!raw) {
        reply.code(400);
        return { ok: false, error: "missing_username" };
      }
      const uname = raw.startsWith("@") ? raw.slice(1) : raw;
      const u = await supabaseAdmin.from("users").select("telegram_user_id, username").ilike("username", uname).limit(5);
      if (u.error) throw u.error;
      const exact = (u.data || []).find((x: any) => String(x.username || "").toLowerCase() === uname.toLowerCase());
      const row = exact || (u.data || [])[0];
      if (!row?.telegram_user_id) {
        reply.code(404);
        return { ok: false, error: "user_not_found", message: "Не нашёл пользователя по username" };
      }
      await sendDm(Number(row.telegram_user_id));
      return { ok: true, target, attempted: 1, sent: 1, failed: 0 };
    }

    if (target !== "paid" && target !== "lead") {
      reply.code(400);
      return { ok: false, error: "invalid_target" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }

    // Active participations -> users
    const parts = await supabaseAdmin.from("participations").select("user_id").eq("challenge_id", challenge.id).is("left_at", null);
    if (parts.error) throw parts.error;
    const userIds = Array.from(new Set((parts.data || []).map((p: any) => String(p.user_id)).filter(Boolean)));

    const usersRes =
      userIds.length > 0 ? await supabaseAdmin.from("users").select("id, telegram_user_id").in("id", userIds as any) : ({ data: [], error: null } as any);
    if (usersRes.error) throw usersRes.error;
    const users = (usersRes.data || []).filter((u: any) => Number.isFinite(Number(u.telegram_user_id)));

    // paid set
    const paidRes =
      userIds.length > 0
        ? await supabaseAdmin.from("payments").select("user_id").eq("challenge_id", challenge.id).eq("status", "paid").in("user_id", userIds as any)
        : ({ data: [], error: null } as any);
    if (paidRes.error) throw paidRes.error;
    const paidSet = new Set<string>((paidRes.data || []).map((r: any) => String(r.user_id)));

    // trial set (active only)
    const trialRes =
      userIds.length > 0
        ? await supabaseAdmin
            .from("wallet_ledger")
            .select("user_id, created_at")
            .eq("challenge_id", challenge.id)
            .eq("reason", "trial_7d_start")
            .in("user_id", userIds as any)
            .order("created_at", { ascending: false })
        : ({ data: [], error: null } as any);
    if (trialRes.error) throw trialRes.error;
    const latestTrial = new Map<string, string>();
    for (const r of (trialRes.data || []) as any[]) {
      const uid = String(r.user_id);
      if (!latestTrial.has(uid) && r.created_at) latestTrial.set(uid, String(r.created_at));
    }
    const trialActiveSet = new Set<string>();
    for (const [uid, startIso] of latestTrial.entries()) {
      const until = new Date(new Date(startIso).getTime() + 7 * 86400000).toISOString();
      if (Date.parse(until) > Date.now()) trialActiveSet.add(uid);
    }

    const recipients = target === "paid" ? users.filter((u: any) => paidSet.has(String(u.id))) : users.filter((u: any) => !paidSet.has(String(u.id)) && !trialActiveSet.has(String(u.id)));

    // Safety limit
    const MAX = 500;
    const sliced = recipients.slice(0, MAX);
    const delayMs = 60;

    let sent = 0;
    let failed = 0;
    const errors: any[] = [];

    for (const u of sliced) {
      const tgId = Number(u.telegram_user_id);
      try {
        await sendDm(tgId);
        sent += 1;
      } catch (e: any) {
        failed += 1;
        if (errors.length < 20) errors.push({ telegram_user_id: tgId, message: e?.message || String(e), details: e?.details || undefined });
      }
      await sleepMs(delayMs);
    }

    return {
      ok: true,
      target,
      challenge_id: challenge.id,
      attempted: sliced.length,
      sent,
      failed,
      truncated: recipients.length > sliced.length,
      errors
    };
  });

  // POST /admin/reminders/trial-offers/run
  // body (optional): { dry_run?: boolean, limit?: number }
  // Purpose: proactively send a DM offer for 7-day trial to inactive leads.
  app.post("/admin/reminders/trial-offers/run", async (req) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const dry_run = Boolean(body.dry_run);
    const limit = Math.min(500, Math.max(10, Number(body.limit || 200)));

    const challenge = await getActiveChallenge();
    if (!challenge) {
      const err: any = new Error("no_active_challenge");
      err.statusCode = 409;
      throw err;
    }

    // Load users (last_seen_at may not exist on older schema; fallback)
    let usersRes: any = await supabaseAdmin
      .from("users")
      .select("id, telegram_user_id, status, created_at, last_seen_at")
      .eq("status", "active");
    if (usersRes.error && isMissingColumnError(usersRes.error, "last_seen_at")) {
      usersRes = await supabaseAdmin.from("users").select("id, telegram_user_id, status, created_at").eq("status", "active");
    }
    if (usersRes.error) throw usersRes.error;

    const now = Date.now();
    const cutoff = now - 2 * 86400000; // 2 days

    const usersAll = (usersRes.data || []).filter((u: any) => Number.isFinite(Number(u.telegram_user_id)));
    const candidates = usersAll
      .map((u: any) => {
        const seen = u.last_seen_at ? Date.parse(String(u.last_seen_at)) : Date.parse(String(u.created_at || ""));
        return { ...u, _seen_ms: Number.isFinite(seen) ? seen : 0 };
      })
      .filter((u: any) => u._seen_ms > 0 && u._seen_ms <= cutoff)
      .slice(0, limit * 3); // cheap pre-limit; final limit applied later

    const candidateIds = Array.from(new Set(candidates.map((u: any) => String(u.id)).filter(Boolean)));
    if (candidateIds.length === 0) {
      return { ok: true, dry_run, attempted: 0, sent: 0, failed: 0, message: "no_candidates" };
    }

    // Already offered
    const offeredRes = await supabaseAdmin
      .from("wallet_ledger")
      .select("user_id")
      .eq("challenge_id", challenge.id)
      .eq("reason", "trial_offer_sent")
      .in("user_id", candidateIds as any);
    if (offeredRes.error) throw offeredRes.error;
    const offeredSet = new Set<string>((offeredRes.data || []).map((r: any) => String(r.user_id)));

    // Paid users
    const paidRes = await supabaseAdmin
      .from("payments")
      .select("user_id")
      .eq("challenge_id", challenge.id)
      .eq("status", "paid")
      .in("user_id", candidateIds as any);
    if (paidRes.error) throw paidRes.error;
    const paidSet = new Set<string>((paidRes.data || []).map((r: any) => String(r.user_id)));

    // Trial active users
    const trialRes = await supabaseAdmin
      .from("wallet_ledger")
      .select("user_id, created_at")
      .eq("challenge_id", challenge.id)
      .eq("reason", "trial_7d_start")
      .in("user_id", candidateIds as any)
      .order("created_at", { ascending: false });
    if (trialRes.error) throw trialRes.error;
    const latestTrialStart = new Map<string, string>();
    for (const r of (trialRes.data || []) as any[]) {
      const uid = String(r.user_id);
      if (!latestTrialStart.has(uid) && r.created_at) latestTrialStart.set(uid, String(r.created_at));
    }
    const trialActiveSet = new Set<string>();
    for (const [uid, startIso] of latestTrialStart.entries()) {
      const until = new Date(new Date(startIso).getTime() + 7 * 86400000).getTime();
      if (Number.isFinite(until) && until > now) trialActiveSet.add(uid);
    }

    const toSend = candidates
      .filter((u: any) => !offeredSet.has(String(u.id)) && !paidSet.has(String(u.id)) && !trialActiveSet.has(String(u.id)))
      .slice(0, limit);

    const text =
      "Привет! Если хочешь, можно попробовать EarlyRise бесплатно 7 дней.\n\n" +
      "Открой /menu и нажми «🎁 Пробная неделя» — включу пробный доступ ✅";

    let sent = 0;
    let failed = 0;
    const errors: any[] = [];

    for (const u of toSend) {
      const tgId = Number(u.telegram_user_id);
      if (dry_run) continue;
      try {
        await telegramSendMessage({ chat_id: tgId, text });
        // Mark as offered (idempotency best-effort)
        const ins = await supabaseAdmin
          .from("wallet_ledger")
          .insert([{ user_id: u.id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason: "trial_offer_sent" }]);
        if (ins.error) {
          // ignore duplicates
        }
        sent += 1;
      } catch (e: any) {
        failed += 1;
        if (errors.length < 20) errors.push({ telegram_user_id: tgId, message: e?.message || String(e), details: e?.details || undefined });
      }
      await sleepMs(60);
    }

    return {
      ok: true,
      dry_run,
      challenge_id: challenge.id,
      attempted: toSend.length,
      sent: dry_run ? 0 : sent,
      failed: dry_run ? 0 : failed,
      sample: toSend.slice(0, 5).map((u: any) => ({ telegram_user_id: u.telegram_user_id, user_id: u.id }))
    };
  });

  // POST /admin/subscriptions/run
  // body (optional): { dry_run?: boolean, limit?: number, chat_id?: string|number }
  // Purpose:
  // - compute paid_until per user based on paid payments + plan_code/amount
  // - send reminder 2 days before end
  // - in the end day: prompt to renew
  // - after +1 day: remove from group chat
  // Notes:
  // - "mark unpaid" is implemented via participations.left_at (so user is treated as non-participant)
  app.post("/admin/subscriptions/run", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const dry_run = Boolean(body.dry_run);
    const limit = Math.min(2000, Math.max(50, Number(body.limit || 1000)));

    const chat_id_str = String(body.chat_id ?? env.EARLYRISE_GROUP_CHAT_ID ?? env.MAIN_CHAT_ID ?? "").trim();
    const chat_id = chat_id_str && /^-?\d+$/.test(chat_id_str) ? chat_id_str : "";

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dayMs = 86400000;

    const paidDaysFromPlanOrAmount = (plan_code: any, amountRub: any): { days: number | null; is_forever: boolean } => {
      const code = String(plan_code || "").trim().toLowerCase();
      if (code === "life" || code === "forever" || code === "support") return { days: null, is_forever: true };
      if (code === "d30" || code === "30" || code === "30d") return { days: 30, is_forever: false };
      if (code === "d60" || code === "60" || code === "60d") return { days: 60, is_forever: false };
      if (code === "d90" || code === "90" || code === "90d") return { days: 90, is_forever: false };
      const a = Number(amountRub);
      if (a === 3000) return { days: null, is_forever: true };
      if (a === 490) return { days: 30, is_forever: false };
      if (a === 890) return { days: 60, is_forever: false };
      if (a === 990) return { days: 60, is_forever: false };
      if (a === 1400) return { days: 90, is_forever: false };
      if (a === 1490) return { days: 90, is_forever: false };
      return { days: null, is_forever: false };
    };

    const fmtDateRu = (iso: string) => {
      const d = new Date(iso);
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
      return `${d.getUTCDate()} ${months[d.getUTCMonth()] || ""} ${d.getUTCFullYear()} года`;
    };

    // All participations (incl left_at): we need to kick even after left_at is set
    const parts = await supabaseAdmin.from("participations").select("user_id, left_at").eq("challenge_id", challenge.id).limit(limit);
    if (parts.error) throw parts.error;
    const partRows = (parts.data || []) as any[];
    const userIds = Array.from(new Set(partRows.map((p) => String(p.user_id)).filter(Boolean)));
    const activePartSet = new Set<string>(partRows.filter((p) => !p.left_at).map((p) => String(p.user_id)));
    if (userIds.length === 0) return { ok: true, dry_run, attempted: 0, message: "no_participants" };

    const hasLedgerMarker = async (user_id: string, reason: string) => {
      const r = await supabaseAdmin
        .from("wallet_ledger")
        .select("id")
        .eq("challenge_id", challenge.id)
        .eq("user_id", user_id)
        .eq("reason", reason)
        .limit(1);
      if (r.error) throw r.error;
      return (r.data || []).length > 0;
    };
    const putLedgerMarker = async (user_id: string, reason: string) => {
      const ins = await supabaseAdmin.from("wallet_ledger").insert([{ user_id, challenge_id: challenge.id, delta: 0, currency: "EUR", reason }]);
      if (ins.error) {
        // no unique constraint; ignore best-effort
      }
    };

    // Load users (subscription columns may not exist on older schema; fallback)
    let usersRes: any = await supabaseAdmin
      .from("users")
      .select("id, telegram_user_id, paid_until, next_payment_reminder_at, reminder_2d_sent_at, expiry_prompt_sent_at, kicked_from_chat_at")
      .in("id", userIds as any);
    if (usersRes.error && isMissingColumnError(usersRes.error, "paid_until")) {
      usersRes = await supabaseAdmin.from("users").select("id, telegram_user_id").in("id", userIds as any);
    }
    if (usersRes.error) throw usersRes.error;
    const users = (usersRes.data || []).filter((u: any) => Number.isFinite(Number(u.telegram_user_id)));
    if (users.length === 0) return { ok: true, dry_run, attempted: 0, message: "no_users" };

    // Paid payments for these users (plan_code may not exist on older schema; fallback)
    let paidRes: any = await supabaseAdmin
      .from("payments")
      .select("user_id, created_at, plan_code, amount")
      .eq("challenge_id", challenge.id)
      .eq("status", "paid")
      .in("user_id", users.map((u: any) => String(u.id)) as any);
    if (paidRes.error && isMissingColumnError(paidRes.error, "plan_code")) {
      paidRes = await supabaseAdmin
        .from("payments")
        .select("user_id, created_at, amount")
        .eq("challenge_id", challenge.id)
        .eq("status", "paid")
        .in("user_id", users.map((u: any) => String(u.id)) as any);
    }
    if (paidRes.error) throw paidRes.error;
    const paidRows = (paidRes.data || []) as any[];

    // Compute max paid_until per user
    const foreverSet = new Set<string>();
    const maxUntilMs = new Map<string, number>();
    for (const r of paidRows) {
      const uid = String(r.user_id || "");
      if (!uid) continue;
      const info = paidDaysFromPlanOrAmount(r.plan_code, r.amount);
      if (info.is_forever) {
        foreverSet.add(uid);
        continue;
      }
      if (!info.days || !r.created_at) continue;
      const startMs = Date.parse(String(r.created_at));
      if (!Number.isFinite(startMs)) continue;
      const untilMs = startMs + info.days * dayMs;
      const prev = maxUntilMs.get(uid);
      if (prev === undefined || untilMs > prev) maxUntilMs.set(uid, untilMs);
    }

    let computed = 0;
    let reminderCandidates = 0;
    let remindersSent = 0;
    let expiryCandidates = 0;
    let expiryPromptsSent = 0;
    let markedUnpaid = 0;
    let kicked = 0;
    const errors: any[] = [];

    for (const u of users) {
      const uid = String(u.id);
      computed += 1;
      const isForever = foreverSet.has(uid);
      const paidUntilMs = isForever ? null : maxUntilMs.get(uid) ?? null;
      const paidUntilIso = paidUntilMs ? new Date(paidUntilMs).toISOString() : null;
      const reminderAtMs = paidUntilMs ? paidUntilMs - 2 * dayMs : null;
      const reminderAtIso = reminderAtMs ? new Date(reminderAtMs).toISOString() : null;

      // Persist computed dates (best-effort; only if columns exist)
      if (!dry_run && "paid_until" in u) {
        try {
          const upd = await supabaseAdmin
            .from("users")
            .update({ paid_until: paidUntilIso, next_payment_reminder_at: reminderAtIso })
            .eq("id", uid);
          if (upd.error && !isMissingColumnError(upd.error, "paid_until")) throw upd.error;
        } catch (e: any) {
          if (errors.length < 10) errors.push({ user_id: uid, step: "update_users_dates", message: e?.message || String(e) });
        }
      }

      if (isForever || !paidUntilMs) continue;

      // Reminder 2 days before end
      if (reminderAtMs && nowMs >= reminderAtMs && nowMs < paidUntilMs) {
        reminderCandidates += 1;
        const marker = `sub:reminder_2d_sent:${paidUntilIso}`;
        const sentAtMs = (u as any).reminder_2d_sent_at ? Date.parse(String((u as any).reminder_2d_sent_at)) : NaN;
        const alreadySentByCol = Number.isFinite(sentAtMs) && sentAtMs >= reminderAtMs;
        const alreadySent = alreadySentByCol || (!(("reminder_2d_sent_at" in u) || ("paid_until" in u)) ? await hasLedgerMarker(uid, marker) : false);
        if (!alreadySent) {
          if (!dry_run) {
            try {
              await telegramSendMessage({
                chat_id: Number(u.telegram_user_id),
                text:
                  `Напоминание: твой период участия заканчивается ${fmtDateRu(paidUntilIso!)}.\n\n` +
                  `Чтобы продлить, открой /menu и выбери тариф.`
              });
              if ("reminder_2d_sent_at" in u) {
                const upd = await supabaseAdmin.from("users").update({ reminder_2d_sent_at: nowIso }).eq("id", uid);
                if (upd.error && !isMissingColumnError(upd.error, "reminder_2d_sent_at")) throw upd.error;
              } else {
                await putLedgerMarker(uid, marker);
              }
              remindersSent += 1;
            } catch (e: any) {
              if (errors.length < 20) errors.push({ telegram_user_id: u.telegram_user_id, step: "send_reminder_2d", message: e?.message || String(e), details: e?.details });
            }
          }
        }
      }

      // End day prompt (when expired, but less than +1 day)
      if (nowMs >= paidUntilMs && nowMs < paidUntilMs + dayMs) {
        expiryCandidates += 1;
        const marker = `sub:expiry_prompt_sent:${paidUntilIso}`;
        const sentAtMs = (u as any).expiry_prompt_sent_at ? Date.parse(String((u as any).expiry_prompt_sent_at)) : NaN;
        const alreadySentByCol = Number.isFinite(sentAtMs) && sentAtMs >= paidUntilMs;
        const alreadySent = alreadySentByCol || (!(("expiry_prompt_sent_at" in u) || ("paid_until" in u)) ? await hasLedgerMarker(uid, marker) : false);
        if (!alreadySent) {
          if (!dry_run) {
            try {
              await telegramSendMessage({
                chat_id: Number(u.telegram_user_id),
                text:
                  "Доступ закончился ⛔️\n\n" +
                  "Чтобы продолжить участие, открой /menu и нажми «Восстановить участие»."
              });
              if ("expiry_prompt_sent_at" in u) {
                const upd = await supabaseAdmin.from("users").update({ expiry_prompt_sent_at: nowIso, last_renewal_prompt_at: nowIso }).eq("id", uid);
                if (upd.error && !isMissingColumnError(upd.error, "expiry_prompt_sent_at")) throw upd.error;
              } else {
                await putLedgerMarker(uid, marker);
              }
              expiryPromptsSent += 1;
            } catch (e: any) {
              if (errors.length < 20) errors.push({ telegram_user_id: u.telegram_user_id, step: "send_expiry_prompt", message: e?.message || String(e), details: e?.details });
            }
          }
        }

        // Mark unpaid (stop participation) as soon as period ends
        if (activePartSet.has(uid)) {
          if (!dry_run) {
            const upd = await supabaseAdmin
              .from("participations")
              .update({ left_at: nowIso })
              .eq("challenge_id", challenge.id)
              .eq("user_id", uid)
              .is("left_at", null);
            if (upd.error) {
              if (errors.length < 20) errors.push({ user_id: uid, step: "mark_left_at", message: (upd.error as any).message || String(upd.error) });
            } else {
              markedUnpaid += 1;
              activePartSet.delete(uid);
            }
          }
        }
      }

      // Kick from group next day
      if (nowMs >= paidUntilMs + dayMs) {
        const marker = `sub:kicked:${paidUntilIso}`;
        const kickedAtMs = (u as any).kicked_from_chat_at ? Date.parse(String((u as any).kicked_from_chat_at)) : NaN;
        const alreadyKickedByCol = Number.isFinite(kickedAtMs) && kickedAtMs >= paidUntilMs + dayMs;
        const alreadyKicked = alreadyKickedByCol || (!(("kicked_from_chat_at" in u) || ("paid_until" in u)) ? await hasLedgerMarker(uid, marker) : false);
        if (!alreadyKicked) {
          if (!chat_id) {
            if (errors.length < 5) errors.push({ step: "kick_missing_chat_id", message: "Set EARLYRISE_GROUP_CHAT_ID or MAIN_CHAT_ID (negative -100... recommended)" });
          } else if (!dry_run) {
            try {
              // Ban for 60 seconds, then unban -> user is removed but can re-join later.
              const untilDate = Math.floor(nowMs / 1000) + 60;
              await telegramBanChatMember({ chat_id, user_id: Number(u.telegram_user_id), until_date: untilDate });
              await telegramUnbanChatMember({ chat_id, user_id: Number(u.telegram_user_id) });
              if ("kicked_from_chat_at" in u) {
                const upd = await supabaseAdmin.from("users").update({ kicked_from_chat_at: nowIso }).eq("id", uid);
                if (upd.error && !isMissingColumnError(upd.error, "kicked_from_chat_at")) throw upd.error;
              } else {
                await putLedgerMarker(uid, marker);
              }
              kicked += 1;
            } catch (e: any) {
              if (errors.length < 20) errors.push({ telegram_user_id: u.telegram_user_id, step: "kick", message: e?.message || String(e), details: e?.details });
            }
          }
        }
      }
    }

    return {
      ok: true,
      dry_run,
      challenge_id: challenge.id,
      chat_id: chat_id || null,
      computed_users: computed,
      reminder_candidates: reminderCandidates,
      reminders_sent: dry_run ? 0 : remindersSent,
      expiry_candidates: expiryCandidates,
      expiry_prompts_sent: dry_run ? 0 : expiryPromptsSent,
      participations_marked_left: dry_run ? 0 : markedUnpaid,
      kicked: dry_run ? 0 : kicked,
      errors
    };
  });

  // POST /admin/penalties/run
  // body (optional): { dry_run?: boolean, limit?: number, chat_id?: string|number }
  // Purpose:
  // - after wake+30 (user local) if no approved group '+' for today -> send DM with penalty choices
  // - 4th miss -> kick user + buddy (left_at) and remove from chat
  app.post("/admin/penalties/run", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const dry_run = Boolean(body.dry_run);
    const limit = Math.min(2000, Math.max(50, Number(body.limit || 1000)));

    const chat_id_str = String(body.chat_id ?? env.EARLYRISE_GROUP_CHAT_ID ?? env.MAIN_CHAT_ID ?? "").trim();
    const chat_id = chat_id_str && /^-?\d+$/.test(chat_id_str) ? chat_id_str : "";

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    const penaltyInfo = (level: number) => {
      if (level <= 1) return { squats: 50, fine: 150, kick: false };
      if (level === 2) return { squats: 100, fine: 300, kick: false };
      if (level === 3) return { squats: 200, fine: 500, kick: false };
      return { squats: 0, fine: 0, kick: true };
    };

    const missMarker = (localDate: string) => `penalty:miss:${localDate}`;
    const noticeMarker = (localDate: string) => `penalty:notice_sent:${localDate}`;

    const hasMarker = async (user_id: string, reason: string) => {
      const r = await supabaseAdmin
        .from("wallet_ledger")
        .select("id")
        .eq("challenge_id", challenge.id)
        .eq("user_id", user_id)
        .eq("reason", reason)
        .limit(1);
      if (r.error) throw r.error;
      return (r.data || []).length > 0;
    };
    const putMarker = async (user_id: string, reason: string) => {
      const ins = await supabaseAdmin.from("wallet_ledger").insert([{ user_id, challenge_id: challenge.id, delta: 0, currency: "RUB", reason }]);
      if (ins.error) {
        // ignore
      }
    };
    const missCount = async (user_id: string) => {
      const r = await supabaseAdmin
        .from("wallet_ledger")
        .select("id")
        .eq("challenge_id", challenge.id)
        .eq("user_id", user_id)
        .ilike("reason", "penalty:miss:%")
        .limit(5000);
      if (r.error) throw r.error;
      return (r.data || []).length;
    };

    // Active participations
    const partsRes = await supabaseAdmin
      .from("participations")
      .select("id, user_id, wake_mode, wake_time_local")
      .eq("challenge_id", challenge.id)
      .is("left_at", null)
      .limit(limit);
    if (partsRes.error) throw partsRes.error;
    const parts = (partsRes.data || []) as any[];
    const userIds = Array.from(new Set(parts.map((p) => String(p.user_id)).filter(Boolean)));
    if (userIds.length === 0) return { ok: true, dry_run, attempted: 0, message: "no_participants" };

    const usersRes = await supabaseAdmin
      .from("users")
      .select("id, telegram_user_id, timezone")
      .in("id", userIds as any);
    if (usersRes.error) throw usersRes.error;
    const usersById = new Map<string, any>((usersRes.data || []).map((u: any) => [String(u.id), u]));

    // Buddy mapping (user_id -> buddy_user_id)
    const partIdToUserId = new Map<string, string>(parts.map((p) => [String(p.id), String(p.user_id)]));
    const buddyRes = await supabaseAdmin
      .from("buddy_pairs")
      .select("participation_a_id, participation_b_id, status")
      .eq("challenge_id", challenge.id)
      .eq("status", "active");
    if (buddyRes.error) throw buddyRes.error;
    const buddyOfUser = new Map<string, string>();
    for (const bp of (buddyRes.data || []) as any[]) {
      const aUser = partIdToUserId.get(String(bp.participation_a_id || ""));
      const bUser = partIdToUserId.get(String(bp.participation_b_id || ""));
      if (aUser && bUser) {
        buddyOfUser.set(aUser, bUser);
        buddyOfUser.set(bUser, aUser);
      }
    }

    let evaluated = 0;
    let noticesSent = 0;
    let kicked = 0;
    let finesPaidNotified = 0;
    const errors: any[] = [];

    for (const p of parts) {
      const user_id = String(p.user_id || "");
      const u = usersById.get(user_id);
      const tgId = Number(u?.telegram_user_id);
      if (!user_id || !Number.isFinite(tgId)) continue;

      const tz = String(u?.timezone || "GMT+00:00");
      const wakeMode = String(p.wake_mode || "fixed");
      if (wakeMode === "flex") continue;
      const wakeStr = String(p.wake_time_local || "").trim();
      const parsedWake = wakeStr ? parseTimeHHMM(wakeStr) : null;
      if (!parsedWake) continue;

      const local = getLocalParts(now, tz);
      const nowMin = minutesOfDay(local.hour, local.minute);
      const wakeMin = minutesOfDay(parsedWake.hour, parsedWake.minute);
      if (nowMin < wakeMin + 30) continue; // only after wake+30

      const { startUtcIso, endUtcIso, localDate } = utcRangeForLocalDay({ now, timeZone: tz });
      evaluated += 1;

      const alreadyNoticed = await hasMarker(user_id, noticeMarker(localDate));
      if (alreadyNoticed) continue;

      // Has approved group plus today?
      const plus = await supabaseAdmin
        .from("checkins")
        .select("id")
        .eq("user_id", user_id)
        .eq("challenge_id", challenge.id)
        .eq("status", "approved")
        .eq("source", "text")
        .ilike("raw_text", "%group_plus%")
        .gte("checkin_at_utc", startUtcIso)
        .lte("checkin_at_utc", endUtcIso)
        .limit(1);
      if (plus.error) throw plus.error;
      if ((plus.data || []).length > 0) {
        // no penalty today
        await putMarker(user_id, noticeMarker(localDate)); // avoid re-check spam
        continue;
      }

      const alreadyMiss = await hasMarker(user_id, missMarker(localDate));
      let level = await missCount(user_id);
      if (!alreadyMiss) {
        level += 1;
        if (!dry_run) {
          await putMarker(user_id, missMarker(localDate));
        }
      } else {
        // marker exists; compute current as total count
        level = Math.max(1, level);
      }

      const info = penaltyInfo(level);
      if (!dry_run) {
        await putMarker(user_id, noticeMarker(localDate));
      }

      // 4th miss => kick with buddy
      if (info.kick) {
        const buddy_user_id = buddyOfUser.get(user_id);
        const toKick = [user_id].concat(buddy_user_id ? [buddy_user_id] : []);
        if (!dry_run) {
          // stop participation
          await supabaseAdmin.from("participations").update({ left_at: nowIso }).eq("challenge_id", challenge.id).in("user_id", toKick as any).is("left_at", null);
          if (chat_id) {
            for (const uid of toKick) {
              const tu = usersById.get(String(uid));
              const tid = Number(tu?.telegram_user_id);
              if (!Number.isFinite(tid)) continue;
              try {
                const untilDate = Math.floor(Date.now() / 1000) + 60;
                await telegramBanChatMember({ chat_id, user_id: tid, until_date: untilDate });
                await telegramUnbanChatMember({ chat_id, user_id: tid });
              } catch (e: any) {
                if (errors.length < 20) errors.push({ step: "kick", telegram_user_id: tid, message: e?.message || String(e), details: e?.details });
              }
            }
          }
        }
        if (!dry_run) {
          for (const uid of toKick) {
            const tu = usersById.get(String(uid));
            const tid = Number(tu?.telegram_user_id);
            if (!Number.isFinite(tid)) continue;
            try {
              await telegramSendMessage({
                chat_id: tid,
                text: "Это 4-й пропуск. Вы вылетаете из челленджа вместе с напарником. ❌\n\nЕсли захочешь вернуться — напиши /menu и восстанови участие."
              });
            } catch (e: any) {
              if (errors.length < 20) errors.push({ step: "dm_kick", telegram_user_id: tid, message: e?.message || String(e), details: e?.details });
            }
          }
        }
        kicked += dry_run ? 0 : 1;
        continue;
      }

      const kb = {
        inline_keyboard: [
          [{ text: "✅ Выполнить штрафное задание", callback_data: `pen:task:${localDate}` }],
          [{ text: "💳 Оплатить штраф", callback_data: `pen:pay:${localDate}` }]
        ]
      };

      const text =
        `Сегодня пропуск №${level}.\n\n` +
        `Выбери вариант до 23:59 по твоей таймзоне:\n` +
        `- ${info.squats} приседаний (видео)\n` +
        `- или штраф ${info.fine} ₽`;

      if (!dry_run) {
        try {
          await telegramSendMessage({ chat_id: tgId, text, reply_markup: kb });
          noticesSent += 1;
        } catch (e: any) {
          if (errors.length < 20) errors.push({ step: "dm_notice", telegram_user_id: tgId, message: e?.message || String(e), details: e?.details });
        }
      }
    }

    // Follow-up: if a fine was paid (payments.status=paid) -> notify user once
    // We rely on markers created by /bot/penalty/pay/create: "penalty:pay_intent:<localDate>|<provider_payment_id>|<amount>"
    const sinceIso = new Date(Date.now() - 3 * 86400000).toISOString();
    const intents = await supabaseAdmin
      .from("wallet_ledger")
      .select("user_id, reason, created_at")
      .eq("challenge_id", challenge.id)
      .ilike("reason", "penalty:pay_intent:%")
      .gte("created_at", sinceIso)
      .limit(2000);
    if (intents.error) throw intents.error;
    for (const row of (intents.data || []) as any[]) {
      const reason = String(row.reason || "");
      const m = reason.match(/^penalty:pay_intent:(\d{4}-\d{2}-\d{2})\|([^|]+)\|(\d+)/);
      if (!m) continue;
      const localDate = m[1];
      const provider_payment_id = m[2];
      const amountRub = Number(m[3]);
      const uid = String(row.user_id || "");
      if (!uid) continue;

      const already = await hasMarker(uid, `penalty:pay_notified:${localDate}|${provider_payment_id}`);
      if (already) continue;

      const pay = await supabaseAdmin
        .from("payments")
        .select("status")
        .eq("challenge_id", challenge.id)
        .eq("user_id", uid)
        .eq("provider_payment_id", provider_payment_id)
        .maybeSingle();
      if (pay.error) throw pay.error;
      if (String((pay.data as any)?.status || "") !== "paid") continue;

      const u = usersById.get(uid);
      const tgId = Number(u?.telegram_user_id);
      if (!Number.isFinite(tgId)) continue;

      if (!dry_run) {
        await putMarker(uid, `penalty:pay_notified:${localDate}|${provider_payment_id}`);
        try {
          await telegramSendMessage({ chat_id: tgId, text: `Штраф оплачен ✅\n\nСумма: ${amountRub} ₽` });
          finesPaidNotified += 1;
        } catch (e: any) {
          if (errors.length < 20) errors.push({ step: "dm_fine_paid", telegram_user_id: tgId, message: e?.message || String(e), details: e?.details });
        }
      }
    }

    return {
      ok: true,
      dry_run,
      challenge_id: challenge.id,
      chat_id: chat_id || null,
      evaluated,
      notices_sent: dry_run ? 0 : noticesSent,
      kicked: dry_run ? 0 : kicked,
      fines_paid_notified: dry_run ? 0 : finesPaidNotified,
      errors
    };
  });

  // GET /admin/chat-ids/recent
  // Returns distinct chat_ids seen in recent "group_plus" checkins.
  app.get("/admin/chat-ids/recent", async (req, reply) => {
    await requireDashboard(req);
    const limit = Math.min(1000, Math.max(50, Number((req.query as any)?.limit || 300)));
    const res = await supabaseAdmin
      .from("checkins")
      .select("raw_text, checkin_at_utc")
      .eq("source", "text")
      .eq("status", "approved")
      .ilike("raw_text", "%group_plus%")
      .order("checkin_at_utc", { ascending: false })
      .limit(limit);
    if (res.error) throw res.error;
    const map = new Map<string, { chat_id: string; last_seen_at_utc: string }>();
    for (const row of res.data || []) {
      const raw = String((row as any).raw_text || "");
      try {
        const j = JSON.parse(raw);
        const chatId = j?.chat_id;
        if (typeof chatId === "number" || (typeof chatId === "string" && /^-?\d+$/.test(chatId))) {
          const key = String(chatId);
          if (!map.has(key)) map.set(key, { chat_id: key, last_seen_at_utc: String((row as any).checkin_at_utc || "") });
        }
      } catch {
        // ignore
      }
    }
    const items = Array.from(map.values());
    if (items.length === 0) {
      reply.code(404);
      return { ok: false, error: "no_chat_ids_found", message: "Пока не нашёл chat_id: нет сохранённых + отметок с метаданными." };
    }
    return { ok: true, items };
  });

  // GET /admin/dashboard/data
  app.get("/admin/dashboard/data", async (req, reply) => {
    await requireDashboard(req);
    const q = req.query as any;
    const daysVal = q.days !== undefined ? Number(q.days) : undefined;
    const wakeFrom = q.wake_from ? String(q.wake_from) : "";
    const wakeTo = q.wake_to ? String(q.wake_to) : "";
    const wakeFromMin = wakeFrom ? parseHHMMToMinutes(wakeFrom) : null;
    const wakeToMin = wakeTo ? parseHHMMToMinutes(wakeTo) : null;
    const { dates, startIso, endIso } = daterangeUtcDays(daysVal !== undefined ? { days: daysVal } : {});

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }

    // Fetch active participations
    const parts = await supabaseAdmin.from("participations").select("id, user_id, wake_time_local, wake_utc_minutes, left_at").eq("challenge_id", challenge.id).is("left_at", null);
    if (parts.error) throw parts.error;
    const partRows = (parts.data || []) as any[];
    const userIds = Array.from(new Set(partRows.map((p) => p.user_id).filter(Boolean)));
    const partIdToUserId = new Map<string, string>();
    for (const p of partRows) {
      if (p?.id && p?.user_id) partIdToUserId.set(String(p.id), String(p.user_id));
    }

    const usersRes = userIds.length ? await supabaseAdmin.from("users").select("id, telegram_user_id, username, first_name, timezone").in("id", userIds) : ({ data: [], error: null } as any);
    if (usersRes.error) throw usersRes.error;
    const usersById = new Map<string, any>((usersRes.data || []).map((u: any) => [u.id, u]));

    // Buddy pairs (active) for this challenge
    const buddyRes = await supabaseAdmin.from("buddy_pairs").select("participation_a_id, participation_b_id, status").eq("challenge_id", challenge.id).eq("status", "active");
    if (buddyRes.error) throw buddyRes.error;
    const buddyOfUser = new Map<string, string>(); // user_id -> buddy_user_id
    for (const bp of (buddyRes.data || []) as any[]) {
      const aUser = partIdToUserId.get(String(bp.participation_a_id || ""));
      const bUser = partIdToUserId.get(String(bp.participation_b_id || ""));
      if (aUser && bUser) {
        buddyOfUser.set(aUser, bUser);
        buddyOfUser.set(bUser, aUser);
      }
    }

    let participants = partRows
      .map((p) => {
        const u = usersById.get(p.user_id);
        const display_name = u?.username ? `@${u.username}` : u?.first_name ? String(u.first_name) : `#${u?.telegram_user_id ?? ""}`;
        const buddyUserId = buddyOfUser.get(String(p.user_id));
        const bu = buddyUserId ? usersById.get(buddyUserId) : null;
        const buddy_display_name = bu?.username ? `@${bu.username}` : bu?.first_name ? String(bu.first_name) : buddyUserId ? `#${bu?.telegram_user_id ?? ""}` : "";
        return {
          participation_id: p.id,
          user_id: p.user_id,
          telegram_user_id: u?.telegram_user_id ?? null,
          username: u?.username ?? null,
          first_name: u?.first_name ?? null,
          timezone: u?.timezone ?? null,
          wake_time_local: p.wake_time_local ?? null,
          wake_utc_minutes: p.wake_utc_minutes ?? null,
          display_name,
          buddy_user_id: buddyUserId ?? null,
          buddy_display_name,
          access_status: "lead" as AccessStatus,
          trial_until_utc: null as string | null,
          paid: false as boolean
        };
      })
      .filter((x) => x.telegram_user_id !== null);

    // Enrich with access status (paid/trial/lead) based on payments + wallet_ledger trial markers
    const ids = participants.map((p) => p.user_id);
    if (ids.length > 0) {
      const paidRes = await supabaseAdmin.from("payments").select("user_id").eq("challenge_id", challenge.id).eq("status", "paid").in("user_id", ids as any);
      if (paidRes.error) throw paidRes.error;
      const paidSet = new Set<string>((paidRes.data || []).map((r: any) => String(r.user_id)));

      const trialRes = await supabaseAdmin
        .from("wallet_ledger")
        .select("user_id, created_at")
        .eq("challenge_id", challenge.id)
        .eq("reason", "trial_7d_start")
        .in("user_id", ids as any)
        .order("created_at", { ascending: false });
      if (trialRes.error) throw trialRes.error;
      const latestTrial = new Map<string, string>();
      for (const r of (trialRes.data || []) as any[]) {
        const uid = String(r.user_id);
        if (!latestTrial.has(uid) && r.created_at) latestTrial.set(uid, String(r.created_at));
      }

      participants = participants.map((p) => {
        const isPaid = paidSet.has(String(p.user_id));
        const tStart = latestTrial.get(String(p.user_id));
        const tUntil = tStart ? new Date(new Date(tStart).getTime() + 7 * 86400000).toISOString() : null;
        const tActive = tUntil ? Date.parse(tUntil) > Date.now() : false;
        const access_status: AccessStatus = isPaid ? "paid" : tActive ? "trial" : "lead";
        return { ...p, paid: isPaid, trial_until_utc: tUntil, access_status };
      });
    }

    // Filter by wake time
    if (wakeFromMin !== null || wakeToMin !== null) {
      participants = participants.filter((p) => {
        if (!p.wake_time_local) return false;
        const m = parseHHMMToMinutes(String(p.wake_time_local));
        if (m === null) return false;
        if (wakeFromMin !== null && m < wakeFromMin) return false;
        if (wakeToMin !== null && m > wakeToMin) return false;
        return true;
      });
    }

    const filteredUserIds = participants.map((p) => p.user_id);

    // Load checkins in range; mark only group '+' messages (raw_text contains group_plus) as requested
    const checkins =
      filteredUserIds.length > 0
        ? await supabaseAdmin
            .from("checkins")
            .select("user_id, checkin_at_utc, source, raw_text, status")
            .in("user_id", filteredUserIds as any)
            .gte("checkin_at_utc", startIso)
            .lte("checkin_at_utc", endIso)
            .eq("status", "approved")
            .eq("source", "text")
            .ilike("raw_text", "%group_plus%")
        : ({ data: [], error: null } as any);
    if (checkins.error) throw checkins.error;

    const marksByUserDate = new Map<string, Set<string>>();
    for (const c of (checkins.data || []) as any[]) {
      const d = toIsoDateUTC(new Date(c.checkin_at_utc));
      const set = marksByUserDate.get(c.user_id) || new Set<string>();
      set.add(d);
      marksByUserDate.set(c.user_id, set);
    }

    const matrix = participants.map((p) => {
      const set = marksByUserDate.get(p.user_id) || new Set<string>();
      const marks: Record<string, string> = {};
      for (const d of dates) marks[d] = set.has(d) ? "+" : "-";
      return { user_id: p.user_id, display_name: p.display_name, marks };
    });

    return { ok: true, challenge: { id: challenge.id, title: challenge.title }, dates, participants, matrix };
  });

  // GET /admin/user/:id (HTML card)
  app.get("/admin/user/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const token = ((req.query as any)?.token || "").toString();
    const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>EarlyRise — User</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 0; background: #0b1220; color: #e5e7eb; }
      .wrap { padding: 16px; max-width: 1200px; margin: 0 auto; }
      .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 12px; }
      a { color: #93c5fd; text-decoration: none; }
      .row { display:flex; gap:12px; flex-wrap: wrap; }
      .kv { display:grid; grid-template-columns: 160px 1fr; gap:8px; font-size: 13px; }
      .k { color:#9ca3af; }
      .v { color:#e5e7eb; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #1f2937; padding: 8px 10px; font-size: 12px; white-space: nowrap; }
      th { background: #0f172a; text-align:left; position: sticky; top: 0; }
      .grid { overflow:auto; border: 1px solid #1f2937; border-radius: 12px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      input { background: #0b1220; border: 1px solid #334155; color: #e5e7eb; border-radius: 8px; padding: 8px 10px; min-width: 220px; }
      button { background: #2563eb; border: 0; color: white; border-radius: 10px; padding: 9px 12px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <h2 style="margin: 4px 0 12px 0;">EarlyRise — Карточка участника</h2>
        <a href="/admin/dashboard${token ? `?token=${escapeHtml(token)}` : ""}">← к дашборду</a>
      </div>
      <div class="card">
        <div class="row" style="align-items:end;">
          <div>
            <div style="font-weight:700; margin-bottom:6px;">Admin token</div>
            <input id="token" value="${escapeHtml(token)}" placeholder="ADMIN_DASHBOARD_TOKEN" />
          </div>
          <div>
            <button id="load">Load</button>
          </div>
        </div>
      </div>
      <div style="height: 12px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Профиль</div>
        <div id="profile" class="kv"></div>
      </div>
      <div style="height: 12px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Напарник</div>
        <div class="row" style="align-items:end;">
          <div style="min-width:260px;">
            <div class="k" style="margin-bottom:6px;">Текущий</div>
            <div id="buddyCurrent" class="v"></div>
          </div>
          <div style="min-width:260px;">
            <div class="k" style="margin-bottom:6px;">Назначить вручную</div>
            <select id="buddySelect" style="background:#0b1220; border:1px solid #334155; color:#e5e7eb; border-radius:8px; padding:8px 10px; min-width:260px;"></select>
          </div>
          <div>
            <button id="assignBuddy">Assign</button>
          </div>
          <div>
            <button id="unpairBuddy" style="background:#ef4444;">Unpair</button>
          </div>
        </div>
        <div class="hint" id="buddyHint"></div>
      </div>
      <div style="height: 12px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Последние чек-ины (200)</div>
        <div class="grid" id="checkins"></div>
      </div>
      <div style="height: 12px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">Платежи (50)</div>
        <div class="grid" id="payments"></div>
      </div>
    </div>
    <script>
      const tokenEl = document.getElementById('token');
      const loadBtn = document.getElementById('load');
      const profileEl = document.getElementById('profile');
      const checkinsEl = document.getElementById('checkins');
      const paymentsEl = document.getElementById('payments');
      const buddyCurrentEl = document.getElementById('buddyCurrent');
      const buddySelectEl = document.getElementById('buddySelect');
      const buddyHintEl = document.getElementById('buddyHint');
      const assignBtn = document.getElementById('assignBuddy');
      const unpairBtn = document.getElementById('unpairBuddy');
      const selfUserId = '${escapeHtml(id)}';

      async function load() {
        loadBtn.disabled = true;
        profileEl.innerHTML = '';
        checkinsEl.innerHTML = '';
        paymentsEl.innerHTML = '';
        buddyCurrentEl.textContent = '';
        buddySelectEl.innerHTML = '';
        buddyHintEl.textContent = '';
        try {
          const token = tokenEl.value.trim();
          const res = await fetch('/admin/user/${encodeURIComponent(id)}/data', { headers: token ? { 'x-admin-token': token } : {} });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { throw new Error(text || ('HTTP ' + res.status)); }
          if (!res.ok) throw new Error(json?.message || json?.error || ('HTTP ' + res.status));

          const u = json.user;
          const s = json.stats || {};
          const name = (u.username ? '@' + u.username : (u.first_name || ('#' + u.telegram_user_id)));
          const tg = u.username ? ('https://t.me/' + u.username) : '';

          const rows = [
            ['Имя', tg ? ('<a href="' + tg + '" target="_blank" rel="noreferrer">' + name + '</a>') : name],
            ['telegram_user_id', String(u.telegram_user_id || '')],
            ['timezone', String(u.timezone || '')],
            ['streak_days', String(s.streak_days ?? '')],
            ['total_checkins', String(s.total_checkins ?? '')],
            ['last_checkin_at_utc', String(s.last_checkin_at_utc ?? '')]
          ];
          profileEl.innerHTML = rows.map(([k,v]) => '<div class="k">' + k + '</div><div class="v">' + v + '</div>').join('');

          // Buddy section
          buddyCurrentEl.textContent = json.buddy?.display_name || '—';
          const optRes = await fetch('/admin/buddy/options', { headers: token ? { 'x-admin-token': token } : {} });
          const optText = await optRes.text();
          let optJson = null;
          try { optJson = JSON.parse(optText); } catch { optJson = null; }
          const options = (optJson && optJson.options) ? optJson.options : [];
          const optsHtml = ['<option value="">— выбрать —</option>'].concat(options
            .filter(o => o.user_id !== selfUserId)
            .map(o => '<option value="' + o.user_id + '">' + o.display_name + '</option>')
          ).join('');
          buddySelectEl.innerHTML = optsHtml;

          const cRows = (json.checkins || []).map(c => {
            const when = c.checkin_at_utc || '';
            const src = c.source || '';
            const status = c.status || '';
            return '<tr>' +
              '<td class="mono">' + when + '</td>' +
              '<td>' + src + '</td>' +
              '<td>' + status + '</td>' +
              '</tr>';
          }).join('');
          checkinsEl.innerHTML = '<table><thead><tr><th>checkin_at_utc</th><th>source</th><th>status</th></tr></thead><tbody>' + cRows + '</tbody></table>';

          const pRows = (json.payments || []).map(p => {
            const when = p.created_at || '';
            const status = p.status || '';
            const amount = (p.amount !== undefined && p.amount !== null) ? String(p.amount) : '';
            const cur = p.currency || '';
            const prov = p.provider || '';
            const pid = p.provider_payment_id || '';
            const plan = p.plan_code || '';
            return '<tr>' +
              '<td class="mono">' + when + '</td>' +
              '<td>' + status + '</td>' +
              '<td>' + amount + '</td>' +
              '<td>' + cur + '</td>' +
              '<td>' + prov + '</td>' +
              '<td class="mono">' + (plan ? plan : '—') + '</td>' +
              '<td class="mono">' + pid + '</td>' +
              '</tr>';
          }).join('');
          paymentsEl.innerHTML = '<table><thead><tr><th>created_at</th><th>status</th><th>amount</th><th>currency</th><th>provider</th><th>plan_code</th><th>provider_payment_id</th></tr></thead><tbody>' + pRows + '</tbody></table>';
        } catch (e) {
          profileEl.innerHTML = '<div class="k">Ошибка</div><div class="v">' + (e && e.message ? e.message : String(e)) + '</div>';
        } finally {
          loadBtn.disabled = false;
        }
      }

      async function assignBuddy() {
        buddyHintEl.textContent = '';
        const token = tokenEl.value.trim();
        const other = buddySelectEl.value;
        if (!other) { buddyHintEl.textContent = 'Выбери участника для назначения.'; return; }
        assignBtn.disabled = true;
        try {
          const res = await fetch('/admin/buddy/assign', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-admin-token': token } : {}),
            body: JSON.stringify({ user_id_a: selfUserId, user_id_b: other })
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { throw new Error(text || ('HTTP ' + res.status)); }
          if (!res.ok || !json.ok) throw new Error(json.message || json.error || ('HTTP ' + res.status));
          buddyHintEl.textContent = 'Напарник назначен ✅';
          await load();
        } catch (e) {
          buddyHintEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        } finally {
          assignBtn.disabled = false;
        }
      }

      async function unpairBuddy() {
        buddyHintEl.textContent = '';
        const token = tokenEl.value.trim();
        unpairBtn.disabled = true;
        try {
          const res = await fetch('/admin/buddy/unpair', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-admin-token': token } : {}),
            body: JSON.stringify({ user_id: selfUserId })
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { throw new Error(text || ('HTTP ' + res.status)); }
          if (!res.ok || !json.ok) throw new Error(json.message || json.error || ('HTTP ' + res.status));
          buddyHintEl.textContent = 'Пара разорвана ✅';
          await load();
        } catch (e) {
          buddyHintEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        } finally {
          unpairBtn.disabled = false;
        }
      }

      loadBtn.addEventListener('click', load);
      assignBtn.addEventListener('click', assignBuddy);
      unpairBtn.addEventListener('click', unpairBuddy);
      load();
    </script>
  </body>
</html>`;
    reply.header("Content-Type", "text/html; charset=utf-8");
    return html;
  });

  // GET /admin/user/:id/data (token protected)
  app.get("/admin/user/:id/data", async (req) => {
    await requireDashboard(req);
    const id = (req.params as any).id as string;
    const user = await supabaseAdmin.from("users").select("*").eq("id", id).single();
    if (user.error) throw user.error;
    const stats = await supabaseAdmin.from("user_stats").select("*").eq("user_id", id).maybeSingle();
    if (stats.error) throw stats.error;
    const checkins = await supabaseAdmin.from("checkins").select("*").eq("user_id", id).order("checkin_at_utc", { ascending: false }).limit(200);
    if (checkins.error) throw checkins.error;

    // Payments (schema may be missing plan_code/order_id/access_days — fallback)
    let paymentsRes: any = await supabaseAdmin
      .from("payments")
      .select("id, created_at, status, amount, currency, provider, provider_payment_id, plan_code, order_id, access_days")
      .eq("user_id", id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (
      paymentsRes.error &&
      (isMissingColumnError(paymentsRes.error, "plan_code") ||
        isMissingColumnError(paymentsRes.error, "order_id") ||
        isMissingColumnError(paymentsRes.error, "access_days"))
    ) {
      paymentsRes = await supabaseAdmin
        .from("payments")
        .select("id, created_at, status, amount, currency, provider, provider_payment_id")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(50);
    }
    if (paymentsRes.error) throw paymentsRes.error;

    const challenge = await getActiveChallenge();
    if (!challenge) return { ok: true, user: user.data, stats: stats.data, checkins: checkins.data || [], payments: paymentsRes.data || [], buddy: null };
    const partId = await getActiveParticipationId(id, challenge.id);
    if (!partId) return { ok: true, user: user.data, stats: stats.data, checkins: checkins.data || [], payments: paymentsRes.data || [], buddy: null };
    const pair = await getBuddyUserForParticipation({ challenge_id: challenge.id, participation_id: partId });
    if (!pair) return { ok: true, user: user.data, stats: stats.data, checkins: checkins.data || [], payments: paymentsRes.data || [], buddy: null };
    const buddyPart = await supabaseAdmin.from("participations").select("user_id").eq("id", pair.buddyParticipationId).single();
    if (buddyPart.error) throw buddyPart.error;
    const buddyUser = await supabaseAdmin.from("users").select("id, telegram_user_id, username, first_name").eq("id", buddyPart.data.user_id).single();
    if (buddyUser.error) throw buddyUser.error;
    const b = buddyUser.data as any;
    const display_name = b.username ? `@${b.username}` : b.first_name ? String(b.first_name) : `#${b.telegram_user_id ?? ""}`;
    return {
      ok: true,
      user: user.data,
      stats: stats.data,
      checkins: checkins.data || [],
      payments: paymentsRes.data || [],
      buddy: { user_id: b.id, display_name }
    };
  });

  // GET /admin/buddy/options (active challenge participants)
  app.get("/admin/buddy/options", async (req) => {
    await requireDashboard(req);
    const challenge = await getActiveChallenge();
    if (!challenge) return { ok: false, error: "no_active_challenge" };
    const parts = await supabaseAdmin.from("participations").select("id, user_id").eq("challenge_id", challenge.id).is("left_at", null);
    if (parts.error) throw parts.error;
    const userIds = Array.from(new Set((parts.data || []).map((p: any) => p.user_id).filter(Boolean)));
    const usersRes = userIds.length ? await supabaseAdmin.from("users").select("id, telegram_user_id, username, first_name").in("id", userIds) : ({ data: [], error: null } as any);
    if (usersRes.error) throw usersRes.error;
    const opts = (usersRes.data || []).map((u: any) => {
      const display_name = u.username ? `@${u.username}` : u.first_name ? String(u.first_name) : `#${u.telegram_user_id ?? ""}`;
      return { user_id: u.id, telegram_user_id: u.telegram_user_id, display_name };
    });
    return { ok: true, challenge: { id: challenge.id, title: challenge.title }, options: opts };
  });

  // POST /admin/buddy/assign { user_id_a, user_id_b }
  app.post("/admin/buddy/assign", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const user_id_a = String(body.user_id_a || "").trim();
    const user_id_b = String(body.user_id_b || "").trim();
    if (!user_id_a || !user_id_b || user_id_a === user_id_b) {
      reply.code(400);
      return { ok: false, error: "invalid_users" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const partA = await getActiveParticipationId(user_id_a, challenge.id);
    const partB = await getActiveParticipationId(user_id_b, challenge.id);
    if (!partA || !partB) {
      reply.code(404);
      return { ok: false, error: "participation_not_found" };
    }

    // Ensure neither side already paired (unique indexes will also enforce)
    const existingA = await getBuddyUserForParticipation({ challenge_id: challenge.id, participation_id: partA });
    const existingB = await getBuddyUserForParticipation({ challenge_id: challenge.id, participation_id: partB });
    if (existingA || existingB) {
      reply.code(409);
      return { ok: false, error: "already_paired" };
    }

    const inserted = await supabaseAdmin
      .from("buddy_pairs")
      .insert([{ challenge_id: challenge.id, participation_a_id: partA, participation_b_id: partB, status: "active" }])
      .select("*")
      .single();
    if (inserted.error) throw inserted.error;

    // Remove from waitlist if present
    await supabaseAdmin.from("buddy_waitlist").delete().eq("challenge_id", challenge.id).in("participation_id", [partA, partB] as any);

    return { ok: true, buddy_pair: inserted.data };
  });

  // POST /admin/buddy/unpair { user_id }
  app.post("/admin/buddy/unpair", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const user_id = String(body.user_id || "").trim();
    if (!user_id) {
      reply.code(400);
      return { ok: false, error: "missing_user_id" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const partId = await getActiveParticipationId(user_id, challenge.id);
    if (!partId) {
      reply.code(404);
      return { ok: false, error: "participation_not_found" };
    }
    const pair = await getBuddyUserForParticipation({ challenge_id: challenge.id, participation_id: partId });
    if (!pair) {
      reply.code(404);
      return { ok: false, error: "not_paired" };
    }
    const upd = await supabaseAdmin.from("buddy_pairs").update({ status: "inactive" }).eq("id", pair.pairId).select("*").single();
    if (upd.error) throw upd.error;
    return { ok: true, buddy_pair: upd.data };
  });

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

  // POST /admin/bootstrap/testers (MVP helper)
  // Body (optional): { timezone?: string, wake_time_local?: "05:00"|"06:00"|"07:00"|"08:00"|"09:00", wake_mode?: "fixed"|"flex" }
  // Purpose: for everyone already in DB, grant "free access" for tests by ensuring:
  // - users.timezone is set (defaults to GMT+03:00)
  // - participation exists in active challenge
  // - wake_mode + wake_time_local are set for participations
  app.post("/admin/bootstrap/testers", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const timezone = normalizeTimezoneToStore(String(body.timezone || "GMT+03:00"));
    const wake_mode = (String(body.wake_mode || "fixed") === "flex" ? "flex" : "fixed") as "fixed" | "flex";
    const wake_time_local = String(body.wake_time_local || "07:00");
    if (wake_mode === "fixed" && !isAllowedWakeTime(wake_time_local)) {
      reply.code(400);
      return { ok: false, error: "invalid_wake_time_local", message: "wake_time_local должен быть одним из: 05:00, 06:00, 07:00, 08:00, 09:00" };
    }

    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }

    const users = await supabaseAdmin.from("users").select("id, timezone");
    if (users.error) throw users.error;

    let updatedUsers = 0;
    let ensuredParticipations = 0;

    for (const u of users.data || []) {
      // If timezone is unset or legacy default, overwrite for tests
      const tz = String((u as any).timezone || "").trim();
      if (!tz || tz === "Europe/Amsterdam") {
        const upd = await supabaseAdmin.from("users").update({ timezone }).eq("id", (u as any).id);
        if (upd.error) throw upd.error;
        updatedUsers += 1;
      }

      const p = await supabaseAdmin.from("participations").select("*").eq("user_id", (u as any).id).eq("challenge_id", challenge.id).maybeSingle();
      if (p.error) throw p.error;

      if (!p.data || p.data.left_at) {
        const ins = await supabaseAdmin
          .from("participations")
          .upsert(
            [
              {
                user_id: (u as any).id,
                challenge_id: challenge.id,
                role: "participant",
                left_at: null,
                wake_mode,
                wake_time_local: wake_mode === "fixed" ? wake_time_local : null,
                wake_utc_minutes: null
              }
            ],
            { onConflict: "user_id,challenge_id" }
          );
        if (ins.error) throw ins.error;
        ensuredParticipations += 1;
      } else {
        const upd = await supabaseAdmin
          .from("participations")
          .update({
            wake_mode,
            wake_time_local: wake_mode === "fixed" ? wake_time_local : null,
            wake_utc_minutes: null
          })
          .eq("id", p.data.id);
        if (upd.error) throw upd.error;
        ensuredParticipations += 1;
      }
    }

    return {
      ok: true,
      challenge_id: challenge.id,
      timezone,
      wake_mode,
      wake_time_local: wake_mode === "fixed" ? wake_time_local : null,
      updated_users: updatedUsers,
      ensured_participations: ensuredParticipations
    };
  });

  // POST /admin/reset/today
  // body: { telegram_user_id: number }
  // Purpose: allow quick testing by deleting today's "DM check-in" (voice-like source='voice') for the user in their timezone.
  app.post("/admin/reset/today", async (req, reply) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const telegram_user_id = Number(body.telegram_user_id);
    if (!telegram_user_id) {
      reply.code(400);
      return { ok: false, error: "missing_telegram_user_id" };
    }
    const userRes = await supabaseAdmin.from("users").select("*").eq("telegram_user_id", telegram_user_id).maybeSingle();
    if (!userRes.data) {
      reply.code(404);
      return { ok: false, error: "user_not_found" };
    }
    const challenge = await getActiveChallenge();
    if (!challenge) {
      reply.code(409);
      return { ok: false, error: "no_active_challenge" };
    }
    const tz = userRes.data.timezone || "GMT+00:00";
    const now = new Date();
    const { startUtcIso, endUtcIso, localDate } = utcRangeForLocalDay({ now, timeZone: tz });
    const del = await supabaseAdmin
      .from("checkins")
      .delete()
      .eq("user_id", userRes.data.id)
      .eq("challenge_id", challenge.id)
      .eq("source", "voice")
      .gte("checkin_at_utc", startUtcIso)
      .lte("checkin_at_utc", endUtcIso)
      .select("id");
    if (del.error) throw del.error;
    return { ok: true, telegram_user_id, user_id: userRes.data.id, challenge_id: challenge.id, local_date: localDate, deleted: (del.data || []).length };
  });

  // POST /admin/maintenance/cleanup-voice-storage
  // body: { dry_run?: boolean }
  app.post("/admin/maintenance/cleanup-voice-storage", async (req) => {
    await requireDashboard(req);
    const body = (req.body || {}) as any;
    const dry_run = Boolean(body.dry_run);
    const res = await cleanupVoiceStorage({ dry_run });
    return { ok: true, dry_run, ...res };
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
}


