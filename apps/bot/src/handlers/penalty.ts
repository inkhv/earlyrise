import { InlineKeyboard, type Bot } from "grammy";
import type { ApiResponse } from "../apiClient.js";
import { clearAwaitingPenaltyVideo, markAwaitingPenaltyVideo } from "../state.js";

function parsePenaltyCb(data: string): { action: "task" | "pay" | "skip"; local_date: string } | null {
  // data: "pen:<task|pay|skip>:YYYY-MM-DD"
  const m = data.match(/^pen:(task|pay|skip):(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  const action = m[1] as any;
  const local_date = m[2];
  if (!local_date) return null;
  return { action, local_date };
}

function parsePenaltyAdminCb(data: string): { action: "ok" | "reject"; telegram_user_id: number; local_date: string } | null {
  // data: "penadm:<ok|reject>:<telegram_user_id>:YYYY-MM-DD"
  const m = data.match(/^penadm:(ok|reject):(\d+):(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  const action = m[1] as any;
  const telegram_user_id = Number(m[2]);
  const local_date = m[3];
  if (!Number.isFinite(telegram_user_id) || !local_date) return null;
  return { action, telegram_user_id, local_date };
}

export function registerPenaltyHandlers(params: {
  bot: Bot;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
  curatorTelegramUserId: number | null;
}) {
  const { bot, api, curatorTelegramUserId } = params;

  bot.callbackQuery(/^pen:(task|pay|skip):\d{4}-\d{2}-\d{2}$/, async (ctx) => {
    if (!ctx.from) return;
    const parsed = parsePenaltyCb(ctx.callbackQuery.data);
    if (!parsed) return;
    await ctx.answerCallbackQuery();

    if (parsed.action === "skip") {
      const rr = await api("/bot/penalty/skip", {
        method: "POST",
        body: JSON.stringify({ telegram_user_id: ctx.from.id, local_date: parsed.local_date })
      });
      const jj: any = rr.json;
      if (!rr.ok || !jj?.ok) {
        return ctx.reply(jj?.message || `Не получилось пропустить штраф (HTTP ${rr.status}).`);
      }
      clearAwaitingPenaltyVideo(ctx.from.id);
      return ctx.reply(String(jj.message || "Ок, штраф пропущен ✅"));
    }

    const choiceRes = await api("/bot/penalty/choose", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: ctx.from.id, local_date: parsed.local_date, choice: parsed.action })
    });
    const choiceJson: any = choiceRes.json;
    if (!choiceRes.ok || !choiceJson?.ok) {
      return ctx.reply(choiceJson?.message || `Ошибка штрафа (HTTP ${choiceRes.status}).`);
    }
    await ctx.reply(String(choiceJson.message || "Ок."));

    if (parsed.action === "pay") {
      clearAwaitingPenaltyVideo(ctx.from.id);
      const payRes = await api("/bot/penalty/pay/create", {
        method: "POST",
        body: JSON.stringify({ telegram_user_id: ctx.from.id, local_date: parsed.local_date })
      });
      const payJson: any = payRes.json;
      if (!payRes.ok || !payJson?.ok) {
        return ctx.reply(payJson?.message || `Не смог создать оплату (HTTP ${payRes.status}).`);
      }
      return ctx.reply(`Ссылка на оплату: ${payJson.payment_url}`);
    }

    // task mode: wait for a single video; block other commands/messages until video is sent.
    markAwaitingPenaltyVideo(ctx.from.id);
  });

  // User sends video -> forward to curator and add approve button
  bot.on("message:video", async (ctx) => {
    if (!ctx.from) return;
    const isPrivate = ctx.chat?.type === "private";
    if (!isPrivate) return;

    const submitRes = await api("/bot/penalty/task/submit", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: ctx.from.id, local_date: "" })
    });
    const submitJson: any = submitRes.json;
    if (!submitRes.ok || !submitJson?.ok) {
      // Not a penalty video OR already handled — keep it minimal.
      const err = String(submitJson?.error || "");
      if (err === "already_submitted" || err === "already_done" || err === "task_not_chosen") {
        const msg = submitJson?.message ? String(submitJson.message) : "Видео больше не нужно ✅";
        try {
          await ctx.reply(msg);
        } catch {
          // ignore
        }
      }
      clearAwaitingPenaltyVideo(ctx.from.id);
      return;
    }

    await ctx.reply("Видео получено ✅ Отправляю куратору на проверку.");
    clearAwaitingPenaltyVideo(ctx.from.id);

    const curatorId = Number.isFinite(Number(submitJson.curator_telegram_user_id))
      ? Number(submitJson.curator_telegram_user_id)
      : curatorTelegramUserId;
    if (!curatorId) {
      return ctx.reply("Не настроен куратор для проверки (CURATOR_TELEGRAM_USER_ID). Напиши Денису, пожалуйста.");
    }

    try {
      await ctx.api.forwardMessage(curatorId, ctx.chat.id, ctx.message.message_id);
    } catch (e: any) {
      return ctx.reply(`Не смог переслать видео куратору: ${e?.message || e}`);
    }

    const k = new InlineKeyboard()
      .text("✅ Принято", `penadm:ok:${ctx.from.id}:${submitJson.local_date || ""}`)
      .text("❌ Не принято", `penadm:reject:${ctx.from.id}:${submitJson.local_date || ""}`);

    await ctx.api.sendMessage(
      curatorId,
      `Штрафное видео от #${ctx.from.id} (${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name || ""}).\n\nПодтвердить?`,
      { reply_markup: k }
    );
  });

  bot.callbackQuery(/^penadm:(ok|reject):\d+:\d{4}-\d{2}-\d{2}$/, async (ctx) => {
    if (!ctx.from) return;
    const parsed = parsePenaltyAdminCb(ctx.callbackQuery.data);
    if (!parsed) return;

    if (!curatorTelegramUserId || ctx.from.id !== curatorTelegramUserId) {
      await ctx.answerCallbackQuery({ text: "Нет доступа" });
      return;
    }
    await ctx.answerCallbackQuery();

    if (parsed.action === "ok") {
      const r = await api("/bot/penalty/task/approve", {
        method: "POST",
        body: JSON.stringify({
          telegram_user_id: parsed.telegram_user_id,
          local_date: parsed.local_date,
          curator_telegram_user_id: ctx.from.id
        })
      });
      const j: any = r.json;
      if (!r.ok || !j?.ok) {
        return ctx.reply(j?.message || `Не смог подтвердить (HTTP ${r.status}).`);
      }
      await ctx.reply("Подтверждено ✅");
      try {
        await ctx.api.sendMessage(parsed.telegram_user_id, "Штрафное задание засчитано ✅");
      } catch {
        // ignore
      }
      return;
    }

    await ctx.reply("Отклонено ❌");
    try {
      await ctx.api.sendMessage(parsed.telegram_user_id, "Похоже, видео не подошло. Пришли, пожалуйста, корректное видео до 23:59 по твоей таймзоне.");
    } catch {
      // ignore
    }
  });
}

