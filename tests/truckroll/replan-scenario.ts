// Phase 3's 10:40 emergency on the demo day (fixture 03 + its golden plan), in fixture ids. Shared by replan.test.ts,
// tr-03-replan.test.ts (translated onto seeded rows) and mirrored by e2e/replan.spec.ts.
import { Problem, type Job, type Plan } from '@/lib/dispatch/contract';
import type { JobState, ReplanInput } from '@/lib/dispatch/replan';
import { fixtures, goldenPlan } from './helpers';

export const AS_OF = 10 * 60 + 40; // 10:40

/** The emergency no-heat call that lands at 10:40. */
export const EMERGENCY: Job = {
  id: 'E1040',
  customer: 'Customer E-1040',
  address: '1040 Example Rd, Synthetic OK',
  location: { lat: 35.765, lng: -95.345 },
  windowStart: AS_OF,
  windowEnd: 12 * 60 + 40,
  durationMin: 60,
  skill: 'repair',
  priority: 'emergency',
};

/** Pins the dispatcher set before planning: J10 is Tahlequah One's 4th stop of the day, J05 stays with Muskogee One. */
export const PINS: Record<string, { techId: string; position?: number }> = { J10: { techId: 'Q1', position: 4 }, J05: { techId: 'M1' } };

/** Work started by 10:40 (the golden plan's times): on site where a stop spans 10:40, done where it ended before. */
export const STATUS: Record<string, JobState> = {
  J11: { status: 'on_site' }, // Muskogee One 10:00–11:00
  J01: { status: 'done' }, // Muskogee Three 08:00–10:00
  J19: { status: 'on_site' }, // Muskogee Three 10:07–10:52
  J02: { status: 'done' },
  J24: { status: 'done' },
  J22: { status: 'on_site' }, // Tahlequah One 10:00–11:00
  J06: { status: 'done' },
  J18: { status: 'done' },
  J08: { status: 'on_site' }, // Tahlequah Three 10:00–11:00
};

/** The demo day with the pins and the emergency added, the golden plan as the current plan, and the statuses. */
export function scenario(): ReplanInput {
  const fx = fixtures.find((f) => f.name === '03-demo-day')!;
  const day = Problem.parse(fx.problem);
  for (const j of day.jobs) if (PINS[j.id]) j.pin = PINS[j.id];
  day.jobs.push(EMERGENCY);
  const status: Record<string, JobState> = {};
  for (const j of day.jobs) status[j.id] = STATUS[j.id] ?? { status: j.id === EMERGENCY.id ? 'unscheduled' : 'scheduled' };
  return { day, base: goldenPlan('03-demo-day') as Plan, status, asOf: AS_OF };
}
