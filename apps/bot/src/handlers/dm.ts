import type { Bot } from "grammy";
import { telegramGetFile } from "@earlyrise/telegram";
import tzLookup from "tz-lookup";
import type { ApiResponse } from "../apiClient.js";
import { handleAntiCheatAnswer, setPendingAntiCheat } from "../flows/antiCheat.js";
import { clearAwaitingTimezone, isAwaitingTimezone, markAwaitingTimezone } from "../state.js";
import { showMainMenu } from "./menu.js";

function parseGmtOffsetInput(input: string): number | null {
  // Accept: "GMT+3", "GMT + 3", "GMT плюс 3", "UTC-7", "GMT+03:30"
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/\s+/g, " ");
  s = s.replace(/плюс/gi, "+").replace(/минус/gi, "-");
  s = s.replace(/\s*([+-])\s*/g, "$1"); // normalize spaces around sign
  const m = s.match(/^(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 14) return null;
  if (mm < 0 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

function fmtGmtOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${hh}:${mm}`;
}

function ianaToGmtOffset(iana: string, date = new Date()): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const tzName = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = Number(m[2]);
    const mm = m[3] ? Number(m[3]) : 0;
    if (hh < 0 || hh > 14) return null;
    if (mm < 0 || mm > 59) return null;
    return sign * (hh * 60 + mm);
  } catch {
    return null;
  }
}

async function telegramDownloadVoiceAsBase64(params: {
  botToken: string;
  fileId: string;
}): Promise<{ base64: string; mime: string; file_id: string }> {
  const file = await telegramGetFile(params.botToken, params.fileId);
  const filePath = file.file_path;
  const url = `https://api.telegram.org/file/bot${params.botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telegram download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const base64 = Buffer.from(buf).toString("base64");
  return { base64, mime: "audio/ogg", file_id: params.fileId };
}

export function registerDmHandlers(params: {
  bot: Bot;
  botToken: string;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
}) {
  const { bot, api, botToken } = params;

  bot.on("message:location", async (ctx) => {
    if (!ctx.from) return;
    if (!isAwaitingTimezone(ctx.from.id)) return;
    const loc = ctx.message.location;
    try {
      const iana = tzLookup(loc.latitude, loc.longitude);
      const offset = ianaToGmtOffset(iana, new Date());
      if (offset === null) {
        return ctx.reply("Не смог определить GMT-смещение по геопозиции. Попробуй написать вручную: GMT+3");
      }
      const tzNorm = fmtGmtOffset(offset);
      const r = await api("/bot/set-timezone", {
        method: "POST",
        body: JSON.stringify({ telegram_user_id: ctx.from.id, timezone: tzNorm })
      });
      if (!r.ok) return ctx.reply(`Ошибка API /settz (${r.status}).`);
      clearAwaitingTimezone(ctx.from.id);
      return ctx.reply(`Ок, таймзона обновлена по геопозиции: ${tzNorm}`);
    } catch (e: any) {
      return ctx.reply(`Не смог определить таймзону по геопозиции. Напиши GMT+3 вручную. (${e?.message || e})`);
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (isGroup) return; // group handled elsewhere

    const msg = ctx.message;
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (!text) return;
    if (text.startsWith("/")) return;

    // Anti-cheat answer flow (DM only)
    const handledAnti = await handleAntiCheatAnswer({
      telegramUserId: ctx.from.id,
      text,
      api,
      reply: (t) => ctx.reply(t)
    });
    if (handledAnti) return;

    // If user is setting timezone in DM: accept GMT text
    if (isAwaitingTimezone(ctx.from.id)) {
      const lower = text.toLowerCase();
      if (lower === "отмена" || lower === "cancel" || lower === "стоп") {
        clearAwaitingTimezone(ctx.from.id);
        await ctx.reply("Ок, отменил.");
        return showMainMenu({ ctx, api });
      }
      const gmt = parseGmtOffsetInput(text);
      if (gmt !== null) {
        const tzNorm = fmtGmtOffset(gmt);
        const r = await api("/bot/set-timezone", {
          method: "POST",
          body: JSON.stringify({ telegram_user_id: ctx.from.id, timezone: tzNorm })
        });
        if (!r.ok) return ctx.reply(`Ошибка API /settz (${r.status}).`);
        clearAwaitingTimezone(ctx.from.id);
        return ctx.reply(`Ок, таймзона обновлена: ${tzNorm}`);
      }
      return ctx.reply("Напиши GMT+3 (или GMT-5), либо отправь геопозицию 📍.");
    }

    // Buttons typed as plain text (best-effort)
    const tLower = text.toLowerCase();
    if (tLower === "отмена" || tLower === "cancel" || tLower === "стоп") {
      // Outside timezone flow: treat as a safe no-op and show menu (avoid accidental "analysis" as check-in).
      await ctx.reply("Ок.");
      return showMainMenu({ ctx, api });
    }
    if (tLower === "меню") return showMainMenu({ ctx, api });
    if (tLower === "о проекте") {
      await ctx.reply(
        "Напиши /menu или нажми кнопку «ℹ️ О проекте» в меню — там кратко и по делу.\n\nЕсли хочешь, могу прислать обзор прямо здесь."
      );
      return;
    }

    // Gate check-in for cold leads: onboarding first.
    try {
      const me = await api<any>(`/bot/me/${ctx.from.id}`, { method: "GET" });
      const status = me?.json?.access?.status;
      if (status === "lead" || status === "expired") {
        await ctx.reply("Похоже, у тебя пока нет доступа к участию. Давай начнём с меню — там оплата/пробная неделя/описание проекта.");
        return showMainMenu({ ctx, api });
      }
    } catch {
      // If API is down, fall back to old behavior below.
    }

    // DM flow: allow text plan check-in as alternative to voice (MVP).
    try {
      await ctx.reply("Спасибо, анализирую. Скоро вернусь с ответом…");
      const r = await api("/bot/checkin/dm_text", {
        method: "POST",
        body: JSON.stringify({
          telegram_user_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name ?? null,
          text
        })
      });
      const res: any = r.json;
      if (r.ok && res?.ok) {
        if (typeof res?.reply_text === "string" && res.reply_text.trim()) {
          await ctx.reply(res.reply_text);
        }
        if (res?.anti_cheat?.checkin_id && res?.anti_cheat?.question) {
          setPendingAntiCheat(ctx.from.id, {
            checkin_id: String(res.anti_cheat.checkin_id),
            expires_at_utc: String(res.anti_cheat.expires_at_utc || "")
          });
          return ctx.reply(`${res.anti_cheat.question}\n\nОтветь числом.`);
        }
        return;
      }
      if (res?.error === "already_voice_today" && typeof res?.message === "string") {
        return ctx.reply(res.message);
      }
    } catch {
      // fall back to instructions below
    }

    return ctx.reply(
      "Я не веду переписку.\n\n" +
        "Можно:\n" +
        "- отправить голосовое с планами на утро\n" +
        "- или написать текстом планы на утро (1–2 предложения)\n\n" +
        "После этого будет короткая задачка."
    );
  });

  bot.on("message:voice", async (ctx) => {
    if (!ctx.from) return;
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    const v = ctx.message.voice;
    // Gate voice check-in for cold leads (DM only)
    if (!isGroup) {
      try {
        const me = await api<any>(`/bot/me/${ctx.from.id}`, { method: "GET" });
        const status = me?.json?.access?.status;
        if (status === "lead" || status === "expired") {
          await ctx.reply("Пока не принимаю чек‑ины: у тебя нет доступа к участию. Открой меню — там описание/оплата/пробная неделя.");
          return showMainMenu({ ctx, api });
        }
      } catch {
        // ignore
      }
    }
    try {
      if (!isGroup) {
        await ctx.reply("Спасибо, анализирую. Скоро вернусь с ответом…");
      }
      const audio = await telegramDownloadVoiceAsBase64({ botToken, fileId: v.file_id });
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
        // New order: curator reply first, then anti-cheat question
        if (typeof res?.reply_text === "string" && res.reply_text.trim()) {
          await ctx.reply(res.reply_text);
        }
        if (res?.anti_cheat?.checkin_id && res?.anti_cheat?.question) {
          setPendingAntiCheat(ctx.from.id, {
            checkin_id: String(res.anti_cheat.checkin_id),
            expires_at_utc: String(res.anti_cheat.expires_at_utc || "")
          });
          return ctx.reply(`${res.anti_cheat.question}\n\nОтветь числом.`);
        }
        return ctx.reply("Принял голосовое ✅");
      }
      if (res?.error === "already_voice_today" && typeof res?.message === "string") {
        return ctx.reply(res.message);
      }
      return ctx.reply(res?.message ? `Voice: ${res.message}` : `Voice: ошибка (HTTP ${r.status})`);
    } catch (e: any) {
      if (isGroup) return;
      return ctx.reply(`Ошибка voice: ${e?.message || e}`);
    }
  });

  console.log("dm handlers ready");
}


