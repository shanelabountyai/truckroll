import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { isDispatcher } from '@/lib/dispatch/roles';
import { readStop } from '@/lib/dispatch/tech-day';
import { hhmm, isoDay } from '@/lib/dispatch/time';

export const metadata = { title: 'Stop' };

// One stop. Another technician's stop 404s exactly like a missing one (TR-05).
export default async function StopPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const s = await readStop(ctx, (await params).id);
  const day = isoDay(s.plan.date);
  const back = isDispatcher(ctx.role) ? `/o/${ctx.slug}/dispatch?date=${day}` : `/o/${ctx.slug}/dispatch/my-day?date=${day}`;
  return (
    <main style={{ maxWidth: 640 }}>
      <p><Link href={back}>← Back</Link></p>
      <h1>Job {s.job.ref}</h1>
      <dl>
        <dt>Customer</dt><dd>{s.job.customer}</dd>
        <dt>Address</dt><dd>{s.job.address}</dd>
        <dt>Technician</dt><dd>{s.tech.name}, stop {s.seq}</dd>
        <dt>Planned</dt><dd>arrive {hhmm(s.arrival)}, work {hhmm(s.start)}–{hhmm(s.end)} ({s.driveMin} min drive{s.lateMin ? `, ${s.lateMin} min late` : ''})</dd>
        <dt>Window</dt><dd>{hhmm(s.job.windowStart)}–{hhmm(s.job.windowEnd)}</dd>
        <dt>Skill · priority</dt><dd>{s.job.skill} · {s.job.priority}</dd>
      </dl>
    </main>
  );
}
