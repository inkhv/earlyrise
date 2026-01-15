// In-memory bot state (MVP). Restarting the bot clears it.

const awaitingTz = new Map<number, true>();
const awaitingPenaltyVideo = new Map<number, true>();

export function markAwaitingTimezone(telegramUserId: number) {
  awaitingTz.set(telegramUserId, true);
}

export function clearAwaitingTimezone(telegramUserId: number) {
  awaitingTz.delete(telegramUserId);
}

export function isAwaitingTimezone(telegramUserId: number): boolean {
  return awaitingTz.has(telegramUserId);
}

export function markAwaitingPenaltyVideo(telegramUserId: number) {
  awaitingPenaltyVideo.set(telegramUserId, true);
}

export function clearAwaitingPenaltyVideo(telegramUserId: number) {
  awaitingPenaltyVideo.delete(telegramUserId);
}

export function isAwaitingPenaltyVideo(telegramUserId: number): boolean {
  return awaitingPenaltyVideo.has(telegramUserId);
}

