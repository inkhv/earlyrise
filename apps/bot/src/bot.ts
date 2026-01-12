import { Bot } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "./apiClient.js";
import { registerGroupHandlers } from "./handlers/group.js";
import { registerDmHandlers } from "./handlers/dm.js";
import { registerMenuHandlers, showMainMenu } from "./handlers/menu.js";
import { registerPenaltyHandlers } from "./handlers/penalty.js";
import { markAwaitingTimezone } from "./state.js";

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
  CURATOR_TELEGRAM_USER_ID?: string;
};

function env(): Env {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    API_BASE_URL: process.env.API_BASE_URL || "http://localhost:3001",
    CURATOR_TELEGRAM_USER_ID: process.env.CURATOR_TELEGRAM_USER_ID
  };
}

export async function startBot() {
  const E = env();
  const bot = new Bot(E.TELEGRAM_BOT_TOKEN);
  const api = createApiClient(E.API_BASE_URL);
  const curatorTelegramUserId = E.CURATOR_TELEGRAM_USER_ID && /^\d+$/.test(E.CURATOR_TELEGRAM_USER_ID) ? Number(E.CURATOR_TELEGRAM_USER_ID) : null;

  async function registerStartGuard(ctx: any) {
    if (ctx.from) {
      await api("/bot/upsert-user", {
        method: "POST",
        body: JSON.stringify({
          telegram_user_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name ?? null
        })
      }).catch((e) => console.error("guard start upsert error", e));
    }
    await showMainMenu({ ctx, api, intro: true }).catch((e) => console.error("guard start menu error", e));
  }

  async function registerMeGuard(ctx: any) {
    await ctx.reply("Запросил профиль…");
    if (!ctx.from) return;
    console.log(
      JSON.stringify({ t: "guard", handler: "me", step: "call_api", user: ctx.from.id, base_url: E.API_BASE_URL })
    );
    const r = await api(`/bot/me/${ctx.from.id}`, { method: "GET" });
    const res: any = r.json;
    console.log(JSON.stringify({ t: "guard", handler: "me", step: "api_done", status: r.status }));
    if (r.ok && res?.user) {
      const s = res?.stats;
      await ctx.reply(
        `Профиль:\n- timezone: ${res.user.timezone}\n- streak: ${s?.streak_days ?? 0}\n- total: ${s?.total_checkins ?? 0}\n- last: ${s?.last_checkin_at_utc ?? "—"}`
      );
      if (res?.offer?.message) {
        await ctx.reply(String(res.offer.message));
      }
    } else {
      await ctx.reply(res?.message || `Ошибка API /me (${r.status}).`);
    }
  }

  // Minimal observability: log only commands so we can confirm updates are received in production.
  bot.use(async (ctx, next) => {
    const text = (ctx.message as any)?.text;
    const isCommand = typeof text === "string" && text.trimStart().startsWith("/");
    if (isCommand) {
      const chatType = (ctx.chat as any)?.type;
      console.log(
        JSON.stringify({
          t: "cmd",
          update_id: (ctx.update as any)?.update_id,
          chat_id: (ctx.chat as any)?.id,
          chat_type: chatType,
          from_id: (ctx.from as any)?.id,
          text: String(text).slice(0, 120)
        })
      );

      // Immediate fallback for /start and /me in private chats (before any other middleware).
      if (chatType === "private") {
        const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase();
        if (cmd === "/start" || cmd.startsWith("/start@")) {
          // Delegate to downstream handlers; guard-level reply handled later in guard middleware.
        } else if (cmd === "/me" || cmd.startsWith("/me@")) {
          // Delegate to downstream handlers.
        }
      }
    }
    return await next();
  });

  // Hard guard: ensure commands in private chats always answer, even if entities are missing.
  bot.on("message:text", async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType !== "private") return next();
    const text = ctx.message?.text || "";
    if (!text.startsWith("/")) return next();
    const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase();
    if (cmd === "/start" || cmd.startsWith("/start@")) {
      console.log(JSON.stringify({ t: "guard", handler: "start", from_id: ctx.from?.id }));
      try {
        // Single-path handling: call downstream start handler once.
        await registerStartGuard(ctx);
      } catch (e: any) {
        console.error("guard start reply failed", e?.message || e);
      }
      return; // stop propagation to avoid двойных ответов
    }
    if (cmd === "/me" || cmd.startsWith("/me@")) {
      console.log(JSON.stringify({ t: "guard", handler: "me", from_id: ctx.from?.id }));
      try {
        await registerMeGuard(ctx);
      } catch (e: any) {
        console.error("guard me reply failed", e?.message || e);
      }
      return; // stop propagation to avoid двойных ответов
    }
    if (cmd === "/menu" || cmd.startsWith("/menu@")) {
      try {
        await showMainMenu({ ctx, api });
      } catch (e: any) {
        console.error("guard menu reply failed", e?.message || e);
        await ctx.reply("Не смог загрузить меню. Попробуй чуть позже.");
      }
      return;
    }
    if (cmd === "/settz" || cmd.startsWith("/settz@")) {
      const tz = ctx.message?.text?.split(" ").slice(1).join(" ").trim() || "";
    if (!tz) {
      if (ctx.from) {
        markAwaitingTimezone(ctx.from.id);
      }
        await ctx.reply("Ок. Пришли таймзону в формате GMT+3 (или GMT-5), либо отправь геопозицию после /settz.");
        return;
      }
      const gmt = (() => {
        let s = tz.trim();
        if (!s) return null;
        s = s.replace(/\s+/g, " ");
        s = s.replace(/плюс/gi, "+").replace(/минус/gi, "-");
        s = s.replace(/\s*([+-])\s*/g, "$1");
        const m = s.match(/^(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
        if (!m) return null;
        const sign = m[1] === "-" ? -1 : 1;
        const hh = Number(m[2]);
        const mm = m[3] ? Number(m[3]) : 0;
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
        if (hh < 0 || hh > 14) return null;
        if (mm < 0 || mm > 59) return null;
        return sign * (hh * 60 + mm);
      })();
      const fmtGmt = (offsetMinutes: number) => {
        const sign = offsetMinutes < 0 ? "-" : "+";
        const abs = Math.abs(offsetMinutes);
        const hh = String(Math.floor(abs / 60)).padStart(2, "0");
        const mm = String(abs % 60).padStart(2, "0");
        return `GMT${sign}${hh}:${mm}`;
      };
      let tzToSave: string | null = null;
      if (gmt !== null) {
        tzToSave = fmtGmt(gmt);
      }
      if (tzToSave) {
        const r = await api("/bot/set-timezone", {
          method: "POST",
          body: JSON.stringify({ telegram_user_id: ctx.from?.id, timezone: tzToSave })
        });
        if (!r.ok) return ctx.reply(`Ошибка API /settz (${r.status}).`);
        return ctx.reply(`Ок, таймзона обновлена: ${tzToSave}`);
      }
      // fallback: just echo guidance
      await ctx.reply("Не понял таймзону. Напиши GMT+3 (или GMT-5), либо отправь геопозицию 📍.");
      return;
    }
    if (cmd === "/join" || cmd.startsWith("/join@")) {
      const arg = ctx.message?.text?.split(" ").slice(1).join(" ").trim() || "";
      if (!arg) {
        return ctx.reply(
          "Формат:\n" +
            "/join 07:00 — фиксированный режим\n" +
            "/join flex — режим без точного времени\n\n" +
            "Доступные фиксированные режимы: 05:00, 06:00, 07:00, 08:00, 09:00"
        );
      }
      try {
        const r = await api("/bot/join", {
          method: "POST",
          body: JSON.stringify({ telegram_user_id: ctx.from?.id, wake_time_local: arg })
        });
        const res: any = r.json;
        if (r.ok && res?.ok) {
          const mode = res?.wake_mode === "flex" ? "без точного времени" : res?.wake_time_local || arg;
          return ctx.reply(`Ты в челлендже: ${res.challenge?.title ?? "Challenge"}\nРежим: ${mode}`);
        }
        return ctx.reply(res?.message ? `Join: ${res.message}` : `Join: ошибка (${r.status})`);
      } catch (e: any) {
        return ctx.reply(`Ошибка join: ${e?.message || e}`);
      }
    }
    if (cmd === "/trial" || cmd.startsWith("/trial@")) {
      const r = await api("/bot/trial/claim", { method: "POST", body: JSON.stringify({ telegram_user_id: ctx.from?.id }) });
      const res: any = r.json;
      if (r.ok && res?.ok) return ctx.reply(res.message || "Пробная неделя активирована ✅");
      return ctx.reply(res?.message || `Trial: ошибка (HTTP ${r.status})`);
    }
    if (cmd === "/pay" || cmd.startsWith("/pay@")) {
      // Show plan selection UI (inline buttons)
      try {
        await ctx.reply("Открой /menu и нажми «💳 Оплатить участие» — там выбор тарифа.");
      } catch {}
      await showMainMenu({ ctx, api });
      return;
    }
    return next();
  });

  // Ensure we are the only consumer (no webhook), and ensure command list is up-to-date.
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  await bot.api.setMyCommands([
    { command: "start", description: "старт" },
    { command: "menu", description: "меню (кнопки)" },
    { command: "me", description: "профиль и статистика" },
    { command: "settz", description: "установить таймзону (GMT+3 или геопозиция)" },
    { command: "trial", description: "активировать пробную неделю (если предложено)" },
    { command: "pay", description: "оплатить участие" },
    { command: "join", description: "время подъёма: /join 07:00 или /join flex" }
  ]);

  // --- Group policy ---
  // Never process commands in group chats: delete them and redirect user to DM.
  bot.use(async (ctx, next) => {
    const chatType = (ctx.chat as any)?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    const text = (ctx.message as any)?.text;
    const isCommand = typeof text === "string" && text.trimStart().startsWith("/");
    if (isGroup && isCommand && ctx.from) {
      // Try to delete command message in group (requires bot admin rights).
      try {
        await ctx.deleteMessage();
      } catch {
        // ignore (no rights / older message / etc.)
      }
      // DM user with onboarding instruction. If user never started bot in DM, Telegram will block; ignore.
      try {
        await ctx.api.sendMessage(
          ctx.from.id,
          "Вижу, что ты пишешь команду в общем чате.\n\n" +
            "Напиши /start тут (в личке), чтобы начать процесс регистрации.\n\n" +
            "Дальше я попрошу таймзону (/settz) и режим подъёма (/join)."
        );
      } catch {
        // ignore
      }
      return;
    }
    return await next();
  });

  registerGroupHandlers({ bot, api });
  registerMenuHandlers({ bot, api });
  registerPenaltyHandlers({ bot, api, curatorTelegramUserId });
  registerDmHandlers({ bot, api, botToken: E.TELEGRAM_BOT_TOKEN });

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  console.log("Bot started (long polling)...");
  await bot.start();
}


