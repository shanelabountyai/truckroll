import type { JobStatus } from '@/lib/dispatch/replan';
import { STATUS_LABEL } from '@/lib/dispatch/replan';
import { C } from '@/app/ui/theme';

// Display helpers for the design pass (docs/design/*.dc.html). Every status and priority is shown as word → glyph →
// colour, so colour is never the only signal (WCAG 1.4.1). Pure presentation: no business rule lives here.

export const STATUS_LOOK: Record<JobStatus, { glyph: string; color: string }> = {
  unscheduled: { glyph: '–', color: C.text3 },
  scheduled: { glyph: '○', color: C.text2 },
  en_route: { glyph: '→', color: C.amberText },
  on_site: { glyph: '●', color: C.blue },
  done: { glyph: '✓', color: C.text2 },
  cant_complete: { glyph: '✕', color: C.redDark },
};

export const PRIORITY_LOOK: Record<string, { glyph: string; color: string; label: string }> = {
  emergency: { glyph: '!', color: C.red, label: 'Emergency' },
  standard: { glyph: '■', color: C.blue, label: 'Standard' },
  maintenance: { glyph: '□', color: C.text2, label: 'Maintenance' },
};

/** A job status as an outlined pill: glyph (hidden from screen readers) + the word. The word is STATUS_LABEL as is. */
export function StatusBadge({ status }: { status: JobStatus }) {
  const look = STATUS_LOOK[status] ?? STATUS_LOOK.scheduled;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 9px', borderRadius: 999, border: `1px solid ${look.color}`, background: '#FFFFFF', color: look.color, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', lineHeight: 1.5, verticalAlign: 'middle' }}>
      <span aria-hidden="true">{look.glyph}</span>
      <span className="tr-cap">{STATUS_LABEL[status] ?? status}</span>
    </span>
  );
}

export function PriorityTag({ priority }: { priority: string }) {
  const look = PRIORITY_LOOK[priority] ?? PRIORITY_LOOK.standard!;
  return (
    <span style={{ color: look.color, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <span aria-hidden="true">{look.glyph}</span> {priority}
    </span>
  );
}

/** 645 → "10:45 AM" (minutes after midnight, D-19). */
export function clock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** An instant as the shop's wall-clock time ("9:48 AM"), America/Chicago until orgs get a zone (D-27). */
export function wall(at: Date | null | undefined): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(at);
}

/** "2026-11-16" → "Monday, Nov 16" (or "Mon, Nov 16" with short). The date is a calendar day, so format it in UTC. */
export function dayName(date: string, short = false): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: short ? 'short' : 'long', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}

/** 61 → "1 h 01 min", 14 → "14 min". */
export function minutes(n: number): string {
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} h ${String(n % 60).padStart(2, '0')} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
