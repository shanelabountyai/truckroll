// Minutes-after-midnight and calendar-day helpers (D-19). Pure.

/** 510 → "08:30". */
export function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "08:30" → 510; null when it is not a valid HH:MM. */
export function parseHHMM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-16" → the Date Prisma stores in a @db.Date column (UTC midnight). */
export function dayOf(date: string): Date {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`not a date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

/** A @db.Date value back to "2026-11-16". */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Today's calendar day in a time zone (D-27: America/Chicago until orgs get a zone setting). */
export function todayIn(timeZone = 'America/Chicago', at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
