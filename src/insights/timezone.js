/**
 * IANA-timezone-aware date helpers using built-in Intl. No deps.
 */

/**
 * Extracts user-local date components for an arbitrary IANA timezone.
 * @param {string} tz - IANA timezone, e.g. "Europe/Rome"
 * @param {Date} [date] - Defaults to now
 * @returns {{ ymd: string, hour: number, minute: number, weekday: string, dayOfMonth: number }}
 */
export function localParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
    dayOfMonth: parseInt(parts.day, 10),
  };
}

/**
 * Returns true if the given string is a valid IANA timezone.
 */
export function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
