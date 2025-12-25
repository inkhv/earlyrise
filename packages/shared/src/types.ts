// Shared domain types (MVP). Keep this file small and explicit.

export type UserStatus = "active" | "paused" | "banned";
export type ChallengeStatus = "draft" | "active" | "closed";
export type ParticipationRole = "participant" | "moderator";
export type CheckinSource = "text" | "voice" | "web";
export type CheckinStatus = "pending" | "approved" | "rejected";
export type PricingMode = "credits";

export interface DbUser {
  id: string;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  timezone: string;
  status: UserStatus;
  created_at: string;
}

export interface DbChallenge {
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  status: ChallengeStatus;
  rules_snapshot: unknown | null;
  created_at: string;
}

export interface DbParticipation {
  id: string;
  user_id: string;
  challenge_id: string;
  joined_at: string;
  left_at: string | null;
  role: ParticipationRole;
}

export interface DbCheckin {
  id: string;
  user_id: string;
  challenge_id: string;
  checkin_at_utc: string;
  source: CheckinSource;
  status: CheckinStatus;
  reject_reason: string | null;
  raw_text: string | null;
  created_at: string;
}

export interface DbVoiceTranscript {
  id: string;
  checkin_id: string;
  provider: string;
  transcript: string | null;
  confidence: number | null;
  raw: unknown | null;
  created_at: string;
}

export interface DbPayment {
  id: string;
  user_id: string;
  challenge_id: string;
  provider: "stripe" | "telegram" | "manual";
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded" | "failed";
  provider_payment_id: string | null;
  created_at: string;
}

export interface DbWalletLedger {
  id: string;
  user_id: string;
  challenge_id: string;
  delta: number;
  currency: string;
  reason: string | null;
  created_at: string;
}

export interface DbSettings {
  id: string;
  scope: "global" | "challenge";
  challenge_id: string | null;
  challenge_active: boolean;
  voice_feedback_enabled: boolean;
  checkin_window_minutes: number;
  pricing_mode: PricingMode;
  pricing_json: unknown | null;
  created_at: string;
}

export interface UserStatsRow {
  user_id: string;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  timezone: string;
  total_checkins: number;
  last_checkin_at_utc: string | null;
  streak_days: number;
}






