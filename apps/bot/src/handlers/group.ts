import type { Bot } from "grammy";
import type { ApiResponse } from "../apiClient.js";

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

const plusReminderSent = new Set<string>(); // key: `${telegram_user_id}:${local_date}` (mark only on successful DM)

export function registerGroupHandlers(params: {
  bot: Bot;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
}) {
  const { bot, api } = params;

  bot.command("chatid", async (ctx) => {
    if (!ctx.chat) return;
    return ctx.reply(`chat_id: ${ctx.chat.id}`);
  });

  bot.command("announce", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (!isGroup) {
      return ctx.reply("Команда /announce работает только в общем чате.");
    }
    try {
      const m = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      const status = (m as any)?.status;
      if (status !== "administrator" && status !== "creator") {
        return ctx.reply("Только админы чата могут делать анонс.");
      }
    } catch {
      return ctx.reply("Не смог проверить права. Дай боту права читать участников/админов чата.");
    }
    await ctx.reply(ANNOUNCEMENT_TEXT);
  });

  // Group flow: count only messages starting with '+', bot stays silent in group.
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from) return;
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (!isGroup) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();
    if (!text.trimStart().startsWith("+")) return next();

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
      if (r.ok && res?.ok) {
        if (res?.needs_voice && typeof res?.local_date === "string") {
          const key = `${ctx.from.id}:${res.local_date}`;
          if (!plusReminderSent.has(key)) {
            try {
              await ctx.api.sendMessage(
                ctx.from.id,
                "Привет! Вижу твой + в чате ✅\n\nЖду голосовое сообщение с планами на утро (1–2 минуты). После голосового будет короткая задачка."
              );
              plusReminderSent.add(key);
            } catch {
              // user may not have started DM with bot, or blocked bot
              console.error(`DM reminder failed for user ${ctx.from.id} (likely no /start in DM yet).`);
            }
          }
        }
      }
      return;
    } catch {
      // Silent in group
      return;
    }
  });
}


