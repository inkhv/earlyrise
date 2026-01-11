import type { ApiResponse } from "../apiClient.js";

export type PendingAntiCheat = { checkin_id: string; expires_at_utc: string };

// telegram_user_id -> pending
const pendingAntiCheat = new Map<number, PendingAntiCheat>();

export function setPendingAntiCheat(telegramUserId: number, pending: PendingAntiCheat) {
  pendingAntiCheat.set(telegramUserId, pending);
}

export function clearPendingAntiCheat(telegramUserId: number) {
  pendingAntiCheat.delete(telegramUserId);
}

export async function handleAntiCheatAnswer(params: {
  telegramUserId: number;
  text: string;
  api: <T = any>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;
  reply: (text: string) => Promise<any>;
}): Promise<boolean> {
  const pending = pendingAntiCheat.get(params.telegramUserId);
  if (!pending) return false;
  try {
    const r = await params.api("/bot/anti-cheat/solve", {
      method: "POST",
      body: JSON.stringify({ telegram_user_id: params.telegramUserId, checkin_id: pending.checkin_id, answer: params.text })
    });
    const res: any = r.json;
    if (r.ok && res?.ok) {
      pendingAntiCheat.delete(params.telegramUserId);
      if (typeof res?.message === "string" && res.message.trim()) {
        await params.reply(res.message);
        return true;
      }
      if (typeof res?.reply_text === "string" && res.reply_text.trim()) {
        await params.reply(res.reply_text);
        return true;
      }
      await params.reply("Засчитано ✅");
      return true;
    }
    // keep pending unless it was closed/expired/failed
    if (res?.error === "expired" || res?.error === "failed" || res?.error === "not_pending") {
      pendingAntiCheat.delete(params.telegramUserId);
    }
    await params.reply(res?.message || "Не понял. Ответь числом.");
    return true;
  } catch (e: any) {
    await params.reply(`Ошибка проверки: ${e?.message || e}`);
    return true;
  }
}


