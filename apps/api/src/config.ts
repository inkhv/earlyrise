import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PORT: string;
  TELEGRAM_BOT_TOKEN?: string | undefined;
  N8N_WEBHOOK_URL?: string | undefined;
  N8N_TEXT_WEBHOOK_URL?: string | undefined;
  VOICE_PROVIDER?: string | undefined; // "openai" | "n8n" | undefined(auto)
  VOICE_STORAGE_BUCKET?: string | undefined; // if set, store voice audio in Supabase Storage
  VOICE_STORAGE_RETENTION_HOURS?: string | undefined; // default 24
  ADMIN_DASHBOARD_TOKEN?: string | undefined;
  TBANK_TERMINAL_KEY?: string | undefined;
  TBANK_PASSWORD?: string | undefined;
  TBANK_NOTIFICATION_URL?: string | undefined; // full URL for T-Bank webhook (overrides PUBLIC_BASE_URL+/payments/webhook)
  PUBLIC_BASE_URL?: string | undefined; // public URL for webhooks (e.g. https://example.com or http://<ip>:5000)
  PAY_PRICE_RUB?: string | undefined; // integer rubles, e.g. "990"
  PAY_ENABLE_TEST_TARIFF?: string | undefined; // "true" to allow test 5 RUB tariff
  OPENAI_API_KEY?: string | undefined;
  OPENAI_API_KEY_FILE?: string | undefined;
  OPENAI_CHAT_MODEL?: string | undefined;
  OPENAI_STT_MODEL?: string | undefined;
  OPENAI_PROMPT_ID?: string | undefined;
  OPENAI_PROMPT_VERSION?: string | undefined;
};

function getEnv(): Env {
  const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }
  const keyFile = process.env.OPENAI_API_KEY_FILE?.trim() || undefined;
  const keyFromFile =
    !process.env.OPENAI_API_KEY && keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : undefined;
  return {
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    PORT: process.env.PORT || "3001",
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL?.trim() || undefined,
    N8N_TEXT_WEBHOOK_URL: process.env.N8N_TEXT_WEBHOOK_URL?.trim() || undefined,
    VOICE_PROVIDER: process.env.VOICE_PROVIDER?.trim() || undefined,
    VOICE_STORAGE_BUCKET: process.env.VOICE_STORAGE_BUCKET?.trim() || undefined,
    VOICE_STORAGE_RETENTION_HOURS: process.env.VOICE_STORAGE_RETENTION_HOURS?.trim() || undefined,
    ADMIN_DASHBOARD_TOKEN: process.env.ADMIN_DASHBOARD_TOKEN?.trim() || undefined,
    TBANK_TERMINAL_KEY: process.env.TBANK_TERMINAL_KEY?.trim() || undefined,
    TBANK_PASSWORD: process.env.TBANK_PASSWORD?.trim() || undefined,
    TBANK_NOTIFICATION_URL: process.env.TBANK_NOTIFICATION_URL?.trim() || undefined,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL?.trim() || undefined,
    PAY_PRICE_RUB: process.env.PAY_PRICE_RUB?.trim() || undefined,
    PAY_ENABLE_TEST_TARIFF: process.env.PAY_ENABLE_TEST_TARIFF?.trim() || undefined,
    OPENAI_API_KEY: keyFromFile || process.env.OPENAI_API_KEY?.trim() || undefined,
    OPENAI_API_KEY_FILE: keyFile,
    OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-5-mini",
    OPENAI_STT_MODEL: process.env.OPENAI_STT_MODEL?.trim() || "whisper-1",
    OPENAI_PROMPT_ID: process.env.OPENAI_PROMPT_ID?.trim() || undefined,
    OPENAI_PROMPT_VERSION: process.env.OPENAI_PROMPT_VERSION?.trim() || "1"
  };
}

export const env = getEnv();

export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});


