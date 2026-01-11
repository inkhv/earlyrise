// In-memory bot state (MVP). Restarting the bot clears it.

const awaitingTz = new Map<number, true>();

export function markAwaitingTimezone(telegramUserId: number) {
  awaitingTz.set(telegramUserId, true);
}

export function clearAwaitingTimezone(telegramUserId: number) {
  awaitingTz.delete(telegramUserId);
}

export function isAwaitingTimezone(telegramUserId: number): boolean {
  return awaitingTz.has(telegramUserId);
}

