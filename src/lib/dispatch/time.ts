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

/** A real calendar day as YYYY-MM-DD. Round-trips through Date, because `Date.parse` rolls 2026-02-30 over to March 2. */
export function isRealDay(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}

/** "2026-11-16" → the Date Prisma stores in a @db.Date column (UTC midnight). */
export function dayOf(date: string): Date {
  if (!isRealDay(date)) throw new Error(`not a date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

/** A @db.Date value back to "2026-11-16". */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Today's calendar day in a time zone (D-27: America/Chicago until orgs get a zone setting). */
export function todayIn(timeZone = 'America/Chicago', at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Minutes after midnight of `at` in `timeZone`, or null when `at` is not on calendar day `day` there (D-27, D-40). */
export function localMinuteOn(at: Date | null | undefined, day: string, timeZone = 'America/Chicago'): number | null {
  if (!at) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  if (`${parts.year}-${parts.month}-${parts.day}` !== day) return null;
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** Now as minutes after midnight in `timeZone` (the re-plan form's default when the board shows today, D-38). */
export function nowMinuteIn(timeZone = 'America/Chicago', at = new Date()): number {
  return localMinuteOn(at, todayIn(timeZone, at), timeZone)!;
}

/** The instant that is `minute` minutes after midnight of calendar day `day` in `timeZone` (inverse of localMinuteOn). */
export function instantAt(day: string, minute: number, timeZone = 'America/Chicago'): Date {
  const wallMs = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(at))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  const target = dayOf(day).getTime() + minute * 60_000; // the wall clock we want, read as if it were UTC
  let t = target;
  for (let i = 0; i < 3; i++) t += target - wallMs(t); // converges in one step except across a DST change
  return new Date(t);
}

/** "2026-11-16" plus `n` calendar days. */
export const addDays = (day: string, n: number) => isoDay(new Date(dayOf(day).getTime() + n * 86_400_000));
