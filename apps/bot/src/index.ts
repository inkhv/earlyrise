import { Bot } from "grammy";
import { isLikelyIanaTimezone } from "@earlyrise/shared";
import { telegramGetFile } from "@earlyrise/telegram";
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

type Env = {
  TELEGRAM_BOT_TOKEN: string;
  API_BASE_URL: string;
};

function env(): Env {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    API_BASE_URL: process.env.API_BASE_URL || "http://localhost:3001"
  };
}

const E = env();
const bot = new Bot(E.TELEGRAM_BOT_TOKEN);

async function api<T = any>(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; json: T | null; text: string }> {
  const res = await fetch(`${E.API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function telegramDownloadVoiceAsBase64(fileId: string): Promise<{ base64: string; mime: string; file_id: string }> {
  const file = await telegramGetFile(E.TELEGRAM_BOT_TOKEN, fileId);
  const filePath = file.file_path;
  const url = `https://api.telegram.org/file/bot${E.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telegram download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const base64 = Buffer.from(buf).toString("base64");
  return { base64, mime: "audio/ogg", file_id: fileId };
}

// Ensure we are the only consumer (no webhook), and ensure command list is up-to-date.
await bot.api.deleteWebhook({ drop_pending_updates: true });
await bot.api.setMyCommands([
  { command: "start", description: "старт" },
  { command: "me", description: "профиль и статистика" },
  { command: "settz", description: "установить таймзону (IANA)" },
  { command: "join", description: "вступить: /join HH:MM" }
]);

bot.command("start", async (ctx) => {
  const u = ctx.from;
  if (u) {
    const r = await api("/bot/upsert-user", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: u.id, username: u.username ?? null, first_name: u.first_name ?? null })
    });
    if (!r.ok) {
      console.error("upsert-user failed", r.status, r.text);
    }
  }
  await ctx.reply(
    "Привет! Это EarlyRise MVP.\n\nКоманды:\n/join 07:00 — вступить\n/me — мои статистики\n/settz Europe/Amsterdam — установить таймзону"
  );
});

bot.command("me", async (ctx) => {
  if (!ctx.from) return;
  const r = await api(`/bot/me/${ctx.from.id}`, { method: "GET" });
  const res: any = r.json;
  if (!r.ok) return ctx.reply(`Ошибка API /me (${r.status}).`);
  if (!res?.user) return ctx.reply("Пока не вижу твоего профиля. Напиши /start");
  const s = res?.stats;
  await ctx.reply(
    `Профиль:\n- timezone: ${res.user.timezone}\n- streak: ${s?.streak_days ?? 0}\n- total: ${s?.total_checkins ?? 0}\n- last: ${s?.last_checkin_at_utc ?? "—"}`
  );
});

bot.command("settz", async (ctx) => {
  if (!ctx.from) return;
  const tz = ctx.message?.text?.split(" ").slice(1).join(" ").trim() || "";
  if (!isLikelyIanaTimezone(tz)) {
    return ctx.reply("Формат таймзоны должен быть как IANA, например Europe/Amsterdam");
  }
  const r = await api("/bot/set-timezone", {
    method: "POST",
    body: JSON.stringify({ telegram_user_id: ctx.from.id, timezone: tz })
  });
  if (!r.ok) return ctx.reply(`Ошибка API /settz (${r.status}).`);
  await ctx.reply(`Ок, таймзона обновлена: ${tz}`);
});

bot.command("join", async (ctx) => {
  if (!ctx.from) return;
  const arg = ctx.message?.text?.split(" ").slice(1).join(" ").trim() || "";
  if (!arg) {
    return ctx.reply("Формат: /join HH:MM\nПример: /join 07:00");
  }
  try {
    const r = await api("/bot/join", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: ctx.from.id, wake_time_local: arg })
    });
    const res: any = r.json;
    if (r.ok && res?.ok) {
      return ctx.reply(`Ты в челлендже: ${res.challenge.title}\nВремя подъёма: ${arg}`);
    }
    return ctx.reply(res?.message ? `Join: ${res.message}` : `Join: ошибка (${r.status})`);
  } catch (e: any) {
    return ctx.reply(`Ошибка join: ${e?.message || e}`);
  }
});

bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  // Group flow: count only messages starting with '+'
  if (isGroup) {
    if (!text.trimStart().startsWith("+")) return;
    try {
      const r = await api("/bot/checkin/plus", {
        method: "POST",
        body: JSON.stringify({
          telegram_user_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name ?? null,
          chat_id: ctx.chat?.id,
          message_id: ctx.message.message_id,
          text
        })
      });
      const res: any = r.json;
      // Silent mode for test group: do not reply in group.
      // If needed later, we can switch to reactions or a low-noise ack.
      if (r.ok && res?.ok) return;
      return;
    } catch (e: any) {
      // Silent in group
      return;
    }
  }

  // Private / DM flow: no active chat with AI. Ask for voice check-in.
  return ctx.reply(
    "Я куратор по ранним подъёмам и не веду переписку.\n\n" +
      "Запиши, пожалуйста, голосовое: как прошёл подъём и какие планы на утро (если планов нет — это ок, просто скажи как есть).\n\n" +
      "Моя цель — помочь тебе прийти к тому, чтобы 80% подъёмов были в нужное время."
  );
});

bot.on("message:voice", async (ctx) => {
  if (!ctx.from) return;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const v = ctx.message.voice;
  try {
    const audio = await telegramDownloadVoiceAsBase64(v.file_id);
    const r = await api("/bot/checkin/voice", {
      method: "POST",
      body: JSON.stringify({
        telegram_user_id: ctx.from.id,
        username: ctx.from.username ?? null,
        first_name: ctx.from.first_name ?? null,
        chat_id: ctx.chat?.id,
        message_id: ctx.message.message_id,
        file_id: v.file_id,
        duration: v.duration,
        audio_base64: audio.base64,
        audio_mime: audio.mime
      })
    });
    const res: any = r.json;
    // Silent mode in group chat; DM can receive ack
    if (isGroup) return;
    if (r.ok && res?.ok) {
      const replyText = res.reply_text || "Принял голосовое ✅";
      return ctx.reply(replyText);
    }
    return ctx.reply(res?.message ? `Voice: ${res.message}` : `Voice: ошибка (HTTP ${r.status})`);
  } catch (e: any) {
    if (isGroup) return;
    return ctx.reply(`Ошибка voice: ${e?.message || e}`);
  }
});

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

console.log("Bot started (long polling)...");
await bot.start();






