import { supabaseAdmin } from "../config.js";

export type AccessStatus = "lead" | "trial" | "paid";

export async function getActiveChallenge() {
  const res = await supabaseAdmin.from("challenges").select("*").eq("status", "active").order("created_at", { ascending: false }).limit(1);
  return res.data?.[0] ?? null;
}

export function isAllowedWakeTime(wakeHHMM: string): boolean {
  return new Set(["05:00", "06:00", "07:00", "08:00", "09:00"]).has(wakeHHMM);
}


