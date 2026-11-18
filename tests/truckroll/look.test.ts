import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PRIORITY_LOOK, STATUS_LOOK, StatusBadge, clock, dayName, minutes, wall } from '@/app/o/[org]/dispatch/look';
import { STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';

// Design pass (PRD §8 DR-03): every status and priority is word + glyph + colour, and the display helpers format the
// engine's integer minutes (D-19) and Chicago wall time (D-27) without changing them.
describe('display helpers', () => {
  it('clock: minutes after midnight as 12-hour time', () => {
    expect([0, 645, 720, 765, 1439].map(clock)).toEqual(['12:00 AM', '10:45 AM', '12:00 PM', '12:45 PM', '11:59 PM']);
  });
  it('minutes: under an hour in minutes, else hours and two-digit minutes', () => {
    expect([0, 14, 60, 61, 117].map(minutes)).toEqual(['0 min', '14 min', '1 h 00 min', '1 h 01 min', '1 h 57 min']);
  });
  it('dayName: a calendar day, never shifted by the server zone', () => {
    expect(dayName('2026-11-16')).toBe('Monday, Nov 16');
    expect(dayName('2026-11-17', true)).toBe('Tue, Nov 17');
  });
  it('wall: an instant in Chicago time', () => {
    expect(wall(new Date('2026-11-16T15:48:00Z'))).toBe('9:48 AM');
    expect(wall(null)).toBe('—');
  });
});

describe('status and priority looks', () => {
  it('every status has a distinct glyph and shows the engine’s own word', () => {
    const statuses = Object.keys(STATUS_LABEL) as JobStatus[];
    expect(new Set(statuses.map((s) => STATUS_LOOK[s].glyph)).size).toBe(statuses.length);
    for (const s of statuses) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status: s }));
      expect(html).toContain(`<span aria-hidden="true">${STATUS_LOOK[s].glyph}</span>`);
      expect(html).toContain(STATUS_LABEL[s]);
    }
  });
  it('every priority has a glyph and a label', () => {
    for (const p of ['emergency', 'standard', 'maintenance']) expect(PRIORITY_LOOK[p]).toMatchObject({ glyph: expect.any(String), label: expect.any(String) });
  });
});
