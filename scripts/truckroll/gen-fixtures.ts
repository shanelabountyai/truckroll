// Writes fixtures/problems/*.json (Phase 1 plan, "Fixtures"). Deterministic: a seeded PRNG, synthetic people and
// addresses only (D-10). Re-run with `npx tsx scripts/truckroll/gen-fixtures.ts`; the output is committed and the
// tests read the committed files, so a generator change shows up as a fixture diff in review.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Problem, type Priority, type ProblemInput, type Reason, type Skill } from '../../src/lib/dispatch/contract';

type Pt = { lat: number; lng: number };
type TechIn = ProblemInput['techs'][number];
type JobIn = ProblemInput['jobs'][number];

export interface Expect {
  /** Job ids that must be on some route. */
  assigned?: string[];
  /** Exact unassigned set with reasons (when the reasons are forced by the data). */
  unassigned?: Record<string, Reason[]>;
  /** Counts by first reason (when the solver may choose which job to drop). */
  unassignedCounts?: Partial<Record<Reason, number>>;
  /** Exact stop order for a tech. */
  sequence?: Record<string, string[]>;
  /** Sum of lateMin bounds (always 0 since D-36: no lateness). */
  lateMin?: { min?: number; max?: number };
  /** Techs whose route must have lunch: null (re-plan after the lunch window). */
  noLunch?: string[];
}

export interface Fixture {
  name: string;
  description: string;
  timeLimitMs: number;
  problem: ProblemInput;
  expect: Expect;
}

const geo = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/geo.json'), 'utf8')) as { shops: { id: string; point: Pt }[] };
const MUSKOGEE = geo.shops.find((s) => s.id === 'muskogee')!.point;
const TAHLEQUAH = geo.shops.find((s) => s.id === 'tahlequah')!.point;
const DATE = '2026-11-16';
const hm = (h: number, m = 0) => h * 60 + m;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREETS = ['Example Rd', 'Sample Ln', 'Placeholder Ave', 'Fictional St', 'Testbed Dr', 'Mockingbird Way', 'Synthetic Blvd', 'Demo Ct'];
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

function maker(seed: number) {
  const r = prng(seed);
  let n = 0;
  const near = (c: Pt, spread: number): Pt => ({ lat: round5(c.lat + (r() * 2 - 1) * spread), lng: round5(c.lng + (r() * 2 - 1) * spread) });
  const job = (id: string, o: Partial<JobIn> & { skill: Skill; priority?: Priority; at?: Pt; spread?: number }): JobIn => {
    n++;
    const { at, spread, ...rest } = o;
    return {
      id,
      customer: `Customer ${String(seed).padStart(2, '0')}-${String(n).padStart(3, '0')}`,
      address: `${100 + Math.floor(r() * 9800)} ${STREETS[Math.floor(r() * STREETS.length)]}, Synthetic OK`,
      location: near(at ?? MUSKOGEE, spread ?? 0.08),
      windowStart: hm(8),
      windowEnd: hm(16),
      durationMin: 60,
      priority: 'standard',
      ...rest,
    };
  };
  return { job, near, r };
}

const tech = (id: string, name: string, skills: Skill[], home: Pt, o: Partial<TechIn> = {}): TechIn => ({
  id,
  name,
  skills,
  shiftStart: hm(8),
  shiftEnd: hm(17),
  home,
  lunch: { earliest: hm(11, 30), latest: hm(13) },
  maxJobs: 8,
  ...o,
});

const ALL: Skill[] = ['install', 'repair', 'maintenance', 'refrigerant-certified'];
const fixtures: Fixture[] = [];
const add = (name: string, description: string, techs: TechIn[], jobs: JobIn[], expect: Expect) =>
  fixtures.push({ name, description, timeLimitMs: 10_000, problem: { version: 1, date: DATE, techs, jobs }, expect });

{
  const { job } = maker(1);
  add('01-single-job', 'One tech, one repair job inside its window.', [tech('T1', 'Tech Alpha', ['repair', 'maintenance'], MUSKOGEE)], [job('J1', { skill: 'repair', windowStart: hm(9), windowEnd: hm(11) })], {
    assigned: ['J1'],
    unassigned: {},
    lateMin: { max: 0 },
  });
}
{
  const { job } = maker(2);
  add(
    '02-skill-split',
    'Two techs with disjoint skills; each job can only go to one of them (TR-01).',
    [tech('T1', 'Tech Install', ['install'], MUSKOGEE), tech('T2', 'Tech Repair', ['repair'], MUSKOGEE)],
    [job('J1', { skill: 'install' }), job('J2', { skill: 'install' }), job('J3', { skill: 'repair' }), job('J4', { skill: 'repair' })],
    { assigned: ['J1', 'J2', 'J3', 'J4'], unassigned: {} },
  );
}
{
  const { job, r } = maker(3);
  const techs = [
    tech('M1', 'Muskogee One', ALL, MUSKOGEE),
    tech('M2', 'Muskogee Two', ['repair', 'maintenance'], MUSKOGEE),
    tech('M3', 'Muskogee Three', ['install', 'repair', 'commercial'], MUSKOGEE, { shiftStart: hm(7), shiftEnd: hm(16), lunch: { earliest: hm(11), latest: hm(12, 30) } }),
    tech('Q1', 'Tahlequah One', ALL, TAHLEQUAH),
    tech('Q2', 'Tahlequah Two', ['repair', 'maintenance', 'refrigerant-certified'], TAHLEQUAH),
    tech('Q3', 'Tahlequah Three', ['maintenance', 'repair'], TAHLEQUAH, { maxJobs: 5 }),
  ];
  const skills: Skill[] = ['repair', 'repair', 'maintenance', 'maintenance', 'install', 'refrigerant-certified'];
  const jobs: JobIn[] = [];
  for (let i = 1; i <= 24; i++) {
    const skill = skills[Math.floor(r() * skills.length)]!;
    const priority: Priority = i % 8 === 0 ? 'emergency' : i % 3 === 0 ? 'maintenance' : 'standard';
    const ws = hm(8) + 60 * Math.floor(r() * 6);
    jobs.push(job(`J${String(i).padStart(2, '0')}`, { skill, priority, at: i % 2 ? MUSKOGEE : TAHLEQUAH, spread: 0.1, windowStart: ws, windowEnd: ws + 120, durationMin: skill === 'install' ? 120 : 45 + 15 * Math.floor(r() * 3) }));
  }
  add('03-demo-day', 'Both shops, six techs, 24 mixed jobs: the demo day. Capacity is ample, so everything is assigned.', techs, jobs, { unassigned: {} });
}
{
  const { job } = maker(4);
  add(
    '04-tight-windows',
    'One tech; three ten-minute windows force the order J1, J2, J3 regardless of geography.',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE)],
    [
      job('J3', { skill: 'repair', windowStart: hm(14), windowEnd: hm(14, 10), spread: 0.04 }),
      job('J1', { skill: 'repair', windowStart: hm(8, 30), windowEnd: hm(8, 40), spread: 0.04 }),
      job('J2', { skill: 'repair', windowStart: hm(10, 30), windowEnd: hm(10, 40), spread: 0.04 }),
    ],
    { sequence: { T1: ['J1', 'J2', 'J3'] }, unassigned: {}, lateMin: { max: 0 } },
  );
}
{
  const { job } = maker(5);
  const jobs = [
    job('M1', { skill: 'maintenance', priority: 'maintenance', durationMin: 120, spread: 0.02 }),
    job('M2', { skill: 'maintenance', priority: 'maintenance', durationMin: 120, spread: 0.02 }),
    job('E1', { skill: 'repair', priority: 'emergency', durationMin: 120, spread: 0.02 }),
    job('M3', { skill: 'maintenance', priority: 'maintenance', durationMin: 120, spread: 0.02 }),
    job('E2', { skill: 'repair', priority: 'emergency', durationMin: 120, spread: 0.02 }),
    job('M4', { skill: 'maintenance', priority: 'maintenance', durationMin: 120, spread: 0.02 }),
  ];
  for (const j of jobs) [j.windowStart, j.windowEnd] = [hm(8), hm(17)];
  add(
    '05-emergency-first',
    'One tech, 540-minute shift, six 120-minute jobs: four fit (480 + lunch + short drives), two do not. Both emergencies must be kept.',
    [tech('T1', 'Tech Alpha', ['repair', 'maintenance'], MUSKOGEE)],
    jobs,
    { assigned: ['E1', 'E2'], unassignedCounts: { 'over-capacity': 2 } },
  );
}
{
  const { job } = maker(6);
  add(
    '06-lunch-squeeze',
    'Back-to-back jobs around noon: lunch must land between J1 (ends 11:30) and J2 (window 12:10–12:20).',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE)],
    [job('J1', { skill: 'repair', windowStart: hm(9), windowEnd: hm(9, 10), durationMin: 150, spread: 0.03 }), job('J2', { skill: 'repair', windowStart: hm(12, 10), windowEnd: hm(12, 20), durationMin: 120, spread: 0.03 })],
    { sequence: { T1: ['J1', 'J2'] }, unassigned: {}, lateMin: { max: 0 } },
  );
}
{
  const { job } = maker(7);
  const jobs = Array.from({ length: 6 }, (_, i) => job(`J${i + 1}`, { skill: 'maintenance', priority: 'maintenance', durationMin: 30, spread: 0.03 }));
  add('07-max-jobs', 'Two techs capped at two jobs each, six short jobs: two are over capacity.', [tech('T1', 'Tech Alpha', ['maintenance'], MUSKOGEE, { maxJobs: 2 }), tech('T2', 'Tech Beta', ['maintenance'], MUSKOGEE, { maxJobs: 2 })], jobs, {
    unassignedCounts: { 'over-capacity': 2 },
  });
}
{
  const { job } = maker(8);
  add(
    '08-missing-skill',
    'A commercial job and nobody holds the commercial skill.',
    [tech('T1', 'Tech Alpha', ['repair', 'maintenance'], MUSKOGEE), tech('T2', 'Tech Beta', ['install'], TAHLEQUAH)],
    [job('J1', { skill: 'repair' }), job('J2', { skill: 'install', at: TAHLEQUAH }), job('J3', { skill: 'commercial', priority: 'emergency' })],
    { assigned: ['J1', 'J2'], unassigned: { J3: ['no-skill'] } },
  );
}
{
  const { job } = maker(9);
  add(
    '09-impossible-window',
    'A 05:00–05:30 window; every shift starts at 08:00, so no tech can be there inside the window (D-36: no lateness).',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE), tech('T2', 'Tech Beta', ['repair'], TAHLEQUAH)],
    [job('J1', { skill: 'repair', windowStart: hm(5), windowEnd: hm(5, 30) }), job('J2', { skill: 'repair' })],
    { assigned: ['J2'], unassigned: { J1: ['no-window-fit'] } },
  );
}
{
  const { job } = maker(10);
  const jobs = Array.from({ length: 8 }, (_, i) => job(`J${i + 1}`, { skill: 'repair', durationMin: 90, spread: 0.015, windowStart: hm(8), windowEnd: hm(17) }));
  add('10-over-capacity', 'One tech, eight 90-minute jobs within two miles of the shop: five fit (450 + lunch + drives ≤ 540), three do not.', [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE)], jobs, {
    unassignedCounts: { 'over-capacity': 3 },
  });
}
{
  const { job } = maker(11);
  add(
    '11-pinned-job',
    'J1 is next to the Muskogee shop but the dispatcher pinned it to the Tahlequah tech.',
    [tech('M1', 'Muskogee One', ['repair'], MUSKOGEE), tech('Q1', 'Tahlequah One', ['repair'], TAHLEQUAH)],
    [job('J1', { skill: 'repair', spread: 0.01, pin: { techId: 'Q1' } }), job('J2', { skill: 'repair', spread: 0.01 }), job('J3', { skill: 'repair', at: TAHLEQUAH, spread: 0.01 })],
    { assigned: ['J1', 'J2', 'J3'], unassigned: {} },
  );
}
{
  const { job } = maker(12);
  add(
    '12-pinned-position',
    'J3 is the farthest job but is pinned to T1 at position 1.',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE)],
    [job('J1', { skill: 'repair', spread: 0.01 }), job('J2', { skill: 'repair', spread: 0.01 }), job('J3', { skill: 'repair', at: { lat: 35.62, lng: -95.5 }, spread: 0.005, pin: { techId: 'T1', position: 1 } })],
    { unassigned: {} },
  );
}
{
  const { job } = maker(13);
  add(
    '13-would-be-late',
    'Two 60-minute jobs with the same 09:00–09:15 window and one tech: either fits alone, but the second would start after 09:15, so it is unassigned (over-capacity, which the checker verifies) instead of late (D-36).',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE)],
    [job('J1', { skill: 'repair', windowStart: hm(9), windowEnd: hm(9, 15), spread: 0.01 }), job('J2', { skill: 'repair', windowStart: hm(9), windowEnd: hm(9, 15), spread: 0.01 })],
    { unassignedCounts: { 'over-capacity': 1 }, lateMin: { max: 0 } },
  );
}
{
  const { job } = maker(14);
  add(
    '14-all-reasons',
    'One job per reason: commercial with no commercial tech, a 04:00 window, and two jobs for a tech capped at one.',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE, { maxJobs: 1 })],
    [job('NS', { skill: 'commercial' }), job('NW', { skill: 'repair', windowStart: hm(4), windowEnd: hm(4, 30) }), job('C1', { skill: 'repair', priority: 'maintenance' }), job('C2', { skill: 'repair', priority: 'emergency' })],
    { assigned: ['C2'], unassigned: { NS: ['no-skill'], NW: ['no-window-fit'], C1: ['over-capacity'] } },
  );
}
{
  const { job } = maker(15);
  add(
    '15-replan-start',
    'Mid-day re-plan: T1 is free at 13:20 at a customer site (after the lunch window), so no lunch is owed.',
    [tech('T1', 'Tech Alpha', ['repair'], MUSKOGEE, { start: { point: { lat: 35.81, lng: -95.3 }, at: hm(13, 20) } }), tech('T2', 'Tech Beta', ['repair'], MUSKOGEE)],
    [job('J1', { skill: 'repair', windowStart: hm(14), windowEnd: hm(15), spread: 0.03 }), job('J2', { skill: 'repair', windowStart: hm(14), windowEnd: hm(16), spread: 0.03 })],
    { assigned: ['J1', 'J2'], unassigned: {}, noLunch: ['T1'] },
  );
}
{
  const { job } = maker(16);
  add(
    '16-pin-never-dropped',
    'T1 takes one job and the maintenance job J1 is pinned to T1: a pin is never dropped (D-37), so the emergency E1 is the one left unassigned (over-capacity). (A pin that cannot be honoured is a pin-conflict, not a plan: tests/truckroll/pins.test.ts.)',
    [tech('T1', 'Tech Alpha', ['repair', 'maintenance'], MUSKOGEE, { maxJobs: 1 })],
    [job('J1', { skill: 'maintenance', priority: 'maintenance', pin: { techId: 'T1' } }), job('E1', { skill: 'repair', priority: 'emergency' })],
    { assigned: ['J1'], unassigned: { E1: ['over-capacity'] } },
  );
}

const dir = join(process.cwd(), 'fixtures/problems');
mkdirSync(dir, { recursive: true });
for (const f of fixtures) {
  Problem.parse(f.problem); // never write a fixture the contract rejects
  writeFileSync(join(dir, `${f.name}.json`), JSON.stringify(f, null, 2) + '\n');
}
console.log(`wrote ${fixtures.length} fixtures to fixtures/problems/`);
