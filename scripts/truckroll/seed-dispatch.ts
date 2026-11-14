import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '@/core/db'; // refuses a cloud database (INV-18)
import { withOrg } from '@/core/db/rls';
import { Problem } from '@/lib/dispatch/contract';
import { dayOf } from '@/lib/dispatch/time';

// `npm run seed:dispatch` (after seed:demo): synthetic dispatch days for the two demo orgs (D-10). Acme gets fixture
// 03-demo-day (6 techs, 24 jobs) and Globex 02-skill-split, both on the fixture's date. Each demo member is linked to
// one technician so My day has something to show (TR-05). Idempotent: the day's jobs and plans are replaced, techs
// are matched by name. One org at a time through withOrg, so no cross-org access (INV-32). The full Muskogee demo seed
// with rolling dates is Phase 4.

const SEEDS = [
  { slug: 'acme', fixture: '03-demo-day', member: 'member@acme.demo.test', memberTech: 'Muskogee One' },
  { slug: 'globex', fixture: '02-skill-split', member: 'member@globex.demo.test', memberTech: 'Tech Repair' },
] as const;

export async function seedDispatch(): Promise<string[]> {
  const out: string[] = [];
  for (const s of SEEDS) {
    const org = await db.org.findUnique({ where: { slug: s.slug }, select: { id: true } });
    if (!org) {
      out.push(`skipped ${s.slug}: run npm run seed:demo first`);
      continue;
    }
    const fx = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/problems', `${s.fixture}.json`), 'utf8')) as { problem: unknown };
    const p = Problem.parse(fx.problem);
    const member = await db.user.findUnique({ where: { email: s.member }, select: { id: true } });
    const day = dayOf(p.date);
    await withOrg({ orgId: org.id }, async (tx) => {
      await tx.dispatchPlan.deleteMany({ where: { orgId: org.id, date: day } }); // stops cascade
      await tx.job.deleteMany({ where: { orgId: org.id, date: day } });
      const techIds = new Map<string, string>();
      for (const t of p.techs) {
        const data = {
          name: t.name, skills: t.skills, shiftStart: t.shiftStart, shiftEnd: t.shiftEnd, homeLat: t.home.lat, homeLng: t.home.lng,
          lunchEarliest: t.lunch.earliest, lunchLatest: t.lunch.latest, maxJobs: t.maxJobs,
          userId: member && t.name === s.memberTech ? member.id : null,
        };
        const found = await tx.technician.findFirst({ where: { orgId: org.id, name: t.name }, select: { id: true } });
        if (data.userId) await tx.technician.updateMany({ where: { orgId: org.id, userId: data.userId, NOT: { name: t.name } }, data: { userId: null } });
        const row = found ? await tx.technician.update({ where: { id: found.id }, data }) : await tx.technician.create({ data: { orgId: org.id, ...data } });
        techIds.set(t.id, row.id);
      }
      await tx.job.createMany({
        data: p.jobs.map((j) => ({
          orgId: org.id, ref: j.id, customer: j.customer, address: j.address, lat: j.location.lat, lng: j.location.lng, date: day,
          windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, skill: j.skill, priority: j.priority,
          pinTechId: j.pin ? techIds.get(j.pin.techId) ?? null : null, pinPosition: j.pin?.position ?? null,
        })),
      });
    });
    out.push(`${s.slug}: ${p.techs.length} technicians, ${p.jobs.length} jobs on ${p.date}${member ? ` (${s.member} is ${s.memberTech})` : ''}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of await seedDispatch()) console.log(line);
  await db.$disconnect();
}
