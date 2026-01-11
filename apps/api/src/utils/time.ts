export function parseGmtOffsetToMinutes(input: string): number | null {
  // Accept: "GMT+3", "GMT+03:00", "UTC-7", "GMT-03:30"
  const s = input.trim();
  const m = s.match(/^(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 14) return null;
  if (mm < 0 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

export function fmtGmtOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${hh}:${mm}`;
}

export function ianaToGmtOffsetMinutes(iana: string, date = new Date()): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const tzName = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = Number(m[2]);
    const mm = m[3] ? Number(m[3]) : 0;
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 14) return null;
    if (mm < 0 || mm > 59) return null;
    return sign * (hh * 60 + mm);
  } catch {
    return null;
  }
}

export function getLocalParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const off = parseGmtOffsetToMinutes(timeZone);
  if (off !== null) {
    const d = new Date(date.getTime() + off * 60000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes()
    };
  }
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute")
  };
}

export function normalizeTimezoneToStore(input: string): string {
  const s = input.trim();
  const off = parseGmtOffsetToMinutes(s);
  if (off !== null) return fmtGmtOffset(off);
  // If user sends IANA (Europe/Amsterdam), convert to current GMT offset and store in GMT±HH:MM as requested.
  if (s.includes("/")) {
    const ianaOff = ianaToGmtOffsetMinutes(s, new Date());
    if (ianaOff !== null) return fmtGmtOffset(ianaOff);
  }
  return s;
}

export function parseTimeHHMM(input: string): { hour: number; minute: number } | null {
  // Accept "H:MM", "HH:MM", and Postgres time strings like "HH:MM:SS"
  const m = input.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (sec < 0 || sec > 59) return null;
  return { hour, minute };
}

export function minutesOfDay(h: number, m: number): number {
  return h * 60 + m;
}

export function fmtHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function isInWindow(nowMinutes: number, startMinutes: number, windowMinutes: number): boolean {
  // MVP: simple forward window [start, start+window]
  const end = startMinutes + windowMinutes;
  return nowMinutes >= startMinutes && nowMinutes <= end;
}

export function offsetMinutesAt(date: Date, timeZone: string): number {
  const parsedOffset = parseGmtOffsetToMinutes(timeZone);
  if (parsedOffset !== null) return parsedOffset;
  // Fallback for IANA: approximate offset for the given date by comparing "local parts" to UTC.
  const local = getLocalParts(date, timeZone);
  const localAsUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0));
  return Math.round((localAsUtc.getTime() - date.getTime()) / 60000); // local - utc in minutes
}

export function utcRangeForLocalDay(params: {
  now: Date;
  timeZone: string;
}): { startUtcIso: string; endUtcIso: string; localDate: string } {
  const { now, timeZone } = params;
  const local = getLocalParts(now, timeZone);
  const localDate = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const offMin = offsetMinutesAt(now, timeZone);
  const localMidnightAsUtcMs = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0, 0);
  const startUtcMs = localMidnightAsUtcMs - offMin * 60000;
  const endUtcMs = startUtcMs + 86400000 - 1;
  return { startUtcIso: new Date(startUtcMs).toISOString(), endUtcIso: new Date(endUtcMs).toISOString(), localDate };
}


