import type { Bot } from "grammy";
import { InlineKeyboard, Keyboard } from "grammy";
import type { ApiResponse } from "../apiClient.js";
import { clearAwaitingTimezone, markAwaitingTimezone } from "../state.js";

type AccessStatus = "paid" | "trial" | "lead";

type MeResponse = {
  user: any | null;
  stats?: any | null;
  challenge?: { id: string; title: string } | null;
  access?: { status: AccessStatus; trial_until_utc?: string | null } | null;
  offer?: { type?: string; message?: string } | null;
};

const CB = {
  stats: "m:stats",
  tz: "m:tz",
  wake: "m:wake",
  pay: "m:pay",
  about: "m:about",
  trial: "m:trial",
  menu: "m:menu",
  back: "m:back",
  wakeFlex: "w:flex",
  wake0500: "w:05:00",
  wake0600: "w:06:00",
  wake0700: "w:07:00",
  wake0800: "w:08:00",
  wake0900: "w:09:00"
} as const;

const PAY = {
  m1: "p:m1",
  m2: "p:m2",
  m3: "p:m3",
  test: "p:test",
  back: "p:back"
} as const;

function isAccessStatus(x: any): x is AccessStatus {
  return x === "paid" || x === "trial" || x === "lead";
}

function accessStatusFromMe(me: MeResponse | null): AccessStatus {
  const s = me?.access?.status;
  return isAccessStatus(s) ? s : "lead";
}

function mainMenuKeyboard(params: { status: AccessStatus; hasTrialOffer: boolean }) {
  const k = new InlineKeyboard();
  if (params.status === "paid" || params.status === "trial") {
    k.text("📊 Статистика", CB.stats).row();
    k.text("🌍 Часовой пояс", CB.tz).text("⏰ Время подъёма", CB.wake).row();
    if (params.status === "trial") k.text("💳 Оплатить участие", CB.pay).row();
    k.text("ℹ️ О проекте", CB.about);
    return k;
  }
  // lead
  k.text("ℹ️ О проекте", CB.about).row();
  k.text("💳 Оплатить участие", CB.pay).row();
  if (params.hasTrialOffer) k.text("🎁 Пробная неделя", CB.trial).row();
  k.text("🔄 Обновить меню", CB.menu);
  return k;
}

function wakeKeyboard() {
  const k = new InlineKeyboard();
  k.text("05:00", CB.wake0500).text("06:00", CB.wake0600).text("07:00", CB.wake0700).row();
  k.text("08:00", CB.wake0800).text("09:00", CB.wake0900).row();
  k.text("Без точного времени (flex)", CB.wakeFlex).row();
  k.text("← Назад", CB.back);
  return k;
}

function payKeyboard() {
  const k = new InlineKeyboard();
  k.text("1 месяц — 490 ₽", PAY.m1).row();
  k.text("2 месяца — 990 ₽", PAY.m2).row();
  k.text("3 месяца — 1490 ₽", PAY.m3).row();
  k.text("Тест — 5 ₽", PAY.test).row();
  k.text("← Назад", PAY.back);
  return k;
}

function aboutText() {
  return (
    "EarlyRise — челлендж ранних пробуждений.\n\n" +
    "Как это работает:\n" +
    "- Устанавливаешь часовой пояс\n" +
    "- Выбираешь время подъёма (или flex)\n" +
    "- Каждое утро: голосовой чек‑ин с планами на утро + короткая задачка (античит)\n" +
    "- В общем чате отмечаешься “+”\n\n" +
    "Фокус — не идеальные дни, а долгосрочная статистика (цель: 80% ранних подъёмов за всё время)."
  );
}

async function fetchMe(api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>, telegramUserId: number) {
  const r = await api<MeResponse>(`/bot/me/${telegramUserId}`, { method: "GET" });
  return { r, me: (r.json || null) as MeResponse | null };
}

export async function showMainMenu(params: {
  ctx: any;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
  intro?: boolean;
}) {
  const { ctx, api } = params;
  if (!ctx.from) return;
  clearAwaitingTimezone(ctx.from.id);

  const { me } = await fetchMe(api, ctx.from.id);
  const status = accessStatusFromMe(me);
  const hasTrialOffer = Boolean(me?.offer?.type === "trial_7d" || (me?.offer as any)?.message);
  const tz = me?.user?.timezone ? String(me.user.timezone) : "—";

  const header =
    status === "paid"
      ? "Ты участник ✅"
      : status === "trial"
        ? "У тебя активна пробная неделя ✅"
        : "Добро пожаловать! Похоже, ты ещё не участвуешь.";

  const hint =
    status === "paid" || status === "trial"
      ? `Твоя таймзона: ${tz}\n\nВыбери действие:`
      : "Выбери действие: узнать подробнее или оплатить участие.";

  const text = `${header}\n\n${hint}`;
  await ctx.reply(text, { reply_markup: mainMenuKeyboard({ status, hasTrialOffer }) });

  if (typeof me?.offer?.message === "string" && me.offer.message.trim()) {
    await ctx.reply(me.offer.message);
  }
}

export function registerMenuHandlers(params: {
  bot: Bot;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
}) {
  const { bot, api } = params;

  bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // ignore
    }
    if (!ctx.from) return;

    const data = String((ctx.callbackQuery as any)?.data || "");

    if (data === CB.menu || data === CB.back) {
      return showMainMenu({ ctx, api });
    }

    if (data === CB.about) {
      await ctx.reply(aboutText());
      return showMainMenu({ ctx, api });
    }

    if (data === CB.stats) {
      const { r, me } = await fetchMe(api, ctx.from.id);
      if (!r.ok || !me?.user) return ctx.reply(`Не смог загрузить профиль (HTTP ${r.status}).`);
      const s = me?.stats;
      await ctx.reply(
        `Профиль:\n- timezone: ${me.user.timezone}\n- streak: ${s?.streak_days ?? 0}\n- total: ${s?.total_checkins ?? 0}\n- last: ${s?.last_checkin_at_utc ?? "—"}`
      );
      return showMainMenu({ ctx, api });
    }

    if (data === CB.tz) {
      markAwaitingTimezone(ctx.from.id);
      const kb = new Keyboard().requestLocation("📍 Отправить геопозицию").row().text("Отмена").oneTime().resized();
      return ctx.reply("Ок. Напиши таймзону в формате GMT+3 (или GMT-5), либо нажми кнопку и отправь геопозицию 📍.", {
        reply_markup: kb
      });
    }

    if (data === CB.wake) {
      return ctx.reply("Выбери режим подъёма:", { reply_markup: wakeKeyboard() });
    }

    if (data === CB.trial) {
      const r = await api("/bot/trial/claim", { method: "POST", body: JSON.stringify({ telegram_user_id: ctx.from.id }) });
      const res: any = r.json;
      if (r.ok && res?.ok) {
        await ctx.reply(res.message || "Пробная неделя активирована ✅");
        return showMainMenu({ ctx, api });
      }
      return ctx.reply(res?.message || `Trial: ошибка (HTTP ${r.status})`);
    }

    if (data === CB.pay) {
      return ctx.reply("Выбери тариф:", { reply_markup: payKeyboard() });
    }
  });

  bot.callbackQuery(/^p:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // ignore
    }
    if (!ctx.from) return;
    const data = String((ctx.callbackQuery as any)?.data || "");
    const plan = data.replace(/^p:/, "").trim();
    if (!plan || plan === "back") return showMainMenu({ ctx, api });

    const r = await api("/bot/pay/create", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: ctx.from.id, plan_code: plan })
    });
    const res: any = r.json;
    if (r.ok && res?.ok && res?.payment_url) {
      const title = res?.plan?.title ? String(res.plan.title) : "";
      const amount = res?.plan?.amount_rub ? ` (${res.plan.amount_rub} ₽)` : "";
      await ctx.reply(`Оплата (Т‑Банк)${title ? `: ${title}${amount}` : ""}\n${res.payment_url}`);
      return showMainMenu({ ctx, api });
    }
    return ctx.reply(res?.message || `Pay: ошибка (HTTP ${r.status})`);
  });

  bot.callbackQuery(/^w:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // ignore
    }
    if (!ctx.from) return;
    const m = String((ctx.callbackQuery as any)?.data || "").match(/^w:(.+)$/);
    const arg = (m?.[1] || "").trim();
    const wake = arg === "flex" ? "flex" : arg;
    const r = await api("/bot/join", { method: "POST", body: JSON.stringify({ telegram_user_id: ctx.from.id, wake_time_local: wake }) });
    const res: any = r.json;
    if (r.ok && res?.ok) {
      const mode = res?.wake_mode === "flex" ? "без точного времени" : res?.wake_time_local || wake;
      await ctx.reply(`Режим обновлён ✅\n${mode}`);
      return showMainMenu({ ctx, api });
    }
    return ctx.reply(res?.message || `Join: ошибка (HTTP ${r.status})`);
  });
}

