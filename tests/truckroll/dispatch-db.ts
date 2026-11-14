// DB fixtures for the Phase 2 tests: put a fixture day into an org and translate its golden plan onto the new ids.
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { Problem, type Plan } from '@/lib/dispatch/contract';
import { dayOf } from '@/lib/dispatch/time';
import { fixtures, goldenPlan } from './helpers';

export type Seeded = { date: string; tech: Map<string, string>; job: Map<string, string>; techByName: Map<string, string> };

/** Writes a fixture's techs and jobs into `orgId`; `links` maps a tech name to the user who is that tech. */
export async function seedFixtureDay(orgId: string, name: string, links: Record<string, string> = {}): Promise<Seeded> {
  const fx = fixtures.find((f) => f.name === name)!;
  const p = Problem.parse(fx.problem);
  const tech = new Map<string, string>();
  const techByName = new Map<string, string>();
  for (const t of p.techs) {
    const row = await db.technician.create({
      data: { orgId, name: t.name, skills: t.skills, shiftStart: t.shiftStart, shiftEnd: t.shiftEnd, homeLat: t.home.lat, homeLng: t.home.lng, lunchEarliest: t.lunch.earliest, lunchLatest: t.lunch.latest, maxJobs: t.maxJobs, userId: links[t.name] ?? null },
    });
    tech.set(t.id, row.id);
    techByName.set(t.name, row.id);
  }
  const job = new Map<string, string>();
  for (const j of p.jobs) {
    const row = await db.job.create({
      data: { orgId, ref: j.id, customer: j.customer, address: j.address, lat: j.location.lat, lng: j.location.lng, date: dayOf(p.date), windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, skill: j.skill, priority: j.priority, pinTechId: j.pin ? tech.get(j.pin.techId)! : null, pinPosition: j.pin?.position ?? null },
    });
    job.set(j.id, row.id);
  }
  return { date: p.date, tech, job, techByName };
}

/** The fixture's committed golden plan with fixture ids swapped for the seeded rows' ids. */
export function translatedGolden(name: string, s: Seeded): Plan {
  const g = structuredClone(goldenPlan(name));
  for (const r of g.routes) {
    r.techId = s.tech.get(r.techId)!;
    for (const st of r.stops) st.jobId = s.job.get(st.jobId)!;
  }
  for (const u of g.unassigned) u.jobId = s.job.get(u.jobId)!;
  return g;
}
