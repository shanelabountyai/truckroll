import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OrgCtx } from '@/core/authz/guards';
import { db } from '@/core/db'; // refuses a cloud database (INV-18)
import { withOrg, type Tx } from '@/core/db/rls';
import { Problem, type Plan, type Problem as ProblemT } from '@/lib/dispatch/contract';
import { buildProblem, savePlanIfValid } from '@/lib/dispatch/plan-store';
import { addDays, dayOf, instantAt, todayIn } from '@/lib/dispatch/time';

// `npm run seed:dispatch` (after seed:demo): the Truckroll demo seed (PRD §7 Phase 4, D-58). Synthetic Muskogee-area
// data only (D-10): made-up customers, "Synthetic OK" addresses, fictional 918-555-01xx phone numbers (D-55).
//  - The fixed day (the fixture's date, 2026-11-16): the e2e's day, unplanned, fixture customer names (D-31).
//  - Rolling days in America/Chicago (D-27): yesterday, finished — a plan saved through the same checker as Plan the day
//    (TR-02) and every stop with recorded statuses and times, so the metrics page has plan vs actual to show; today
//    and tomorrow, unplanned, for the live demo (README "Demo script"). A rolling day that falls on the fixed day is
//    skipped: the fixed day always wins.
// Each demo member is linked to one technician (TR-05). Idempotent: the seeded days' jobs, plans and ETA texts are
// replaced, techs are matched by name. One org at a time through withOrg, so no cross-org access (INV-32).

const SEEDS = [
  { slug: 'acme', fixture: '03-demo-day', member: 'member@acme.demo.test', memberTech: 'Muskogee One', golden: '03-demo-day' },
  { slug: 'globex', fixture: '02-skill-split', member: 'member@globex.demo.test', memberTech: 'Tech Repair', golden: '02-skill-split' },
] as const;

// Invented people (no real customers, D-10). Deterministic by job index.
const FIRST = ['Avery', 'Blake', 'Casey', 'Dana', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jules', 'Kendall', 'Logan', 'Marlow', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sawyer', 'Tatum'];
const LAST = ['Ashby', 'Brennan', 'Calloway', 'Dunmore', 'Ellery', 'Fairbank', 'Galloway', 'Hollis', 'Ingram', 'Jessup', 'Kimbrell', 'Lindell', 'Mayfield', 'Norwood', 'Overby'];
export const demoCustomer = (i: number) => `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
export const demoPhone = (i: number) => `918-555-01${String(i % 100).padStart(2, '0')}`;

type Kind = 'fixed' | 'finished' | 'open';

export async function seedDispatch(opts: { today?: string } = {}): Promise<string[]> {
  const out: string[] = [];
  const today = opts.today ?? todayIn();
  for (const s of SEEDS) {
    const org = await db.org.findUnique({ where: { slug: s.slug }, select: { id: true } });
    if (!org) {
      out.push(`skipped ${s.slug}: run npm run seed:demo first`);
      continue;
    }
    const fx = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/problems', `${s.fixture}.json`), 'utf8')) as { problem: unknown };
    const p = Problem.parse(fx.problem);
    const golden = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/plans', `${s.golden}.json`), 'utf8')) as Plan;
    const member = await db.user.findUnique({ where: { email: s.member }, select: { id: true } });
    const days = new Map<string, Kind>([[p.date, 'fixed']]);
    for (const [d, k] of [[addDays(today, -1), 'finished'], [today, 'open'], [addDays(today, 1), 'open']] as const) if (!days.has(d)) days.set(d, k);

    const techIds = await withOrg({ orgId: org.id }, (tx) => upsertTechs(tx, org.id, p, member?.id ?? null, s.memberTech));
    const notes: string[] = [];
    for (const [day, kind] of days) {
      const jobIds = await withOrg({ orgId: org.id }, (tx) => replaceDay(tx, org.id, p, day, kind, techIds));
      if (kind === 'finished') notes.push(`${day} finished (${await finishDay(org.id, s.slug, day, p, golden, techIds, jobIds)})`);
      else notes.push(`${day} ${kind === 'fixed' ? 'fixed e2e day' : 'to plan'}`);
    }
    out.push(`${s.slug}: ${p.techs.length} technicians, ${p.jobs.length} jobs a day: ${notes.join('; ')}${member ? ` (${s.member} is ${s.memberTech})` : ''}`);
  }
  return out;
}

async function upsertTechs(tx: Tx, orgId: string, p: ProblemT, memberId: string | null, memberTech: string): Promise<Map<string, string>> {
  const techIds = new Map<string, string>();
  for (const t of p.techs) {
    const data = {
      name: t.name, skills: t.skills, shiftStart: t.shiftStart, shiftEnd: t.shiftEnd, homeLat: t.home.lat, homeLng: t.home.lng,
      lunchEarliest: t.lunch.earliest, lunchLatest: t.lunch.latest, maxJobs: t.maxJobs,
      userId: memberId && t.name === memberTech ? memberId : null,
    };
    const found = await tx.technician.findFirst({ where: { orgId, name: t.name }, select: { id: true } });
    if (data.userId) await tx.technician.updateMany({ where: { orgId, userId: data.userId, NOT: { name: t.name } }, data: { userId: null } });
    const row = found ? await tx.technician.update({ where: { id: found.id }, data }) : await tx.technician.create({ data: { orgId, ...data } });
    techIds.set(t.id, row.id);
  }
  return techIds;
}

/** The day's jobs, replaced: plans (stops and ETA texts cascade) first, then jobs. Returns fixture job id → row id. */
async function replaceDay(tx: Tx, orgId: string, p: ProblemT, day: string, kind: Kind, techIds: Map<string, string>): Promise<Map<string, string>> {
  const date = dayOf(day);
  await tx.dispatchPlan.deleteMany({ where: { orgId, date } });
  await tx.job.deleteMany({ where: { orgId, date } });
  const ids = new Map<string, string>();
  for (const [i, j] of p.jobs.entries()) {
    const row = await tx.job.create({
      data: {
        orgId, ref: j.id, customer: kind === 'fixed' ? j.customer : demoCustomer(i), address: j.address, lat: j.location.lat, lng: j.location.lng, date,
        windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, skill: j.skill, priority: j.priority,
        pinTechId: j.pin ? techIds.get(j.pin.techId) ?? null : null, pinPosition: j.pin?.position ?? null, customerPhone: demoPhone(i),
      },
      select: { id: true },
    });
    ids.set(j.id, row.id);
  }
  return ids;
}

/**
 * Yesterday: the fixture's golden plan, moved onto the seeded rows, saved through savePlanIfValid (the checker decides,
 * TR-02), then synthetic actuals: each stop on site a little off plan and done a little off its estimate; one stop
 * can't be completed. Deterministic, so the metrics page shows the same numbers every time.
 */
async function finishDay(orgId: string, slug: string, day: string, p: ProblemT, golden: Plan, techIds: Map<string, string>, jobIds: Map<string, string>): Promise<string> {
  const plan = { ...structuredClone(golden), date: day };
  for (const r of plan.routes) {
    r.techId = techIds.get(r.techId)!;
    for (const st of r.stops) st.jobId = jobIds.get(st.jobId)!;
  }
  for (const u of plan.unassigned) u.jobId = jobIds.get(u.jobId)!;
  const ctx = { orgId, userId: null, slug } as unknown as OrgCtx; // the seed acts as the system (audit actor null)
  const saved = await withOrg({ orgId }, async (tx) => savePlanIfValid(tx, ctx, await buildProblem(tx, orgId, day), plan));
  if (!saved.ok) throw new Error(`seed: the ${day} plan failed the checker (${saved.codes.join(', ')})`);
  const duration = new Map(p.jobs.map((j) => [jobIds.get(j.id)!, j.durationMin]));
  const stops = plan.routes.flatMap((r) => r.stops);
  await withOrg({ orgId }, async (tx) => {
    for (const [i, st] of stops.entries()) {
      const late = ((i * 37) % 31) - 8; // −8 … +22 minutes against the planned start
      const long = ((i * 53) % 25) - 10; // −10 … +14 minutes against the estimate
      const onSite = st.start + late;
      const cant = i === 5;
      const end = onSite + Math.max(10, (cant ? 20 : duration.get(st.jobId)!) + long);
      await tx.job.update({
        where: { id: st.jobId },
        data: {
          status: cant ? 'cant_complete' : 'done',
          enRouteAt: instantAt(day, onSite - Math.max(st.driveMin, 1)),
          onSiteAt: instantAt(day, onSite),
          doneAt: instantAt(day, end),
          statusNote: cant ? 'Customer not home; left a door tag (demo data).' : null,
        },
      });
    }
  });
  return `${stops.length} stops done or can't complete`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of await seedDispatch()) console.log(line);
  await db.$disconnect();
}
