// Minimal timezone validation (IANA format). Not perfect, but good MVP guard.

export function isLikelyIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  // Basic shape: Area/City, allow underscores and dashes.
  return /^[A-Za-z]+(?:[_-][A-Za-z]+)*\/[A-Za-z]+(?:[_-][A-Za-z]+)*$/.test(tz);
}






