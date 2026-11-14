import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import type { JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { readStop } from '@/lib/dispatch/tech-day';
import { hhmm, isoDay } from '@/lib/dispatch/time';
import { StatusBadge, StatusButtons } from '../../status-buttons';

export const metadata = { title: 'Stop' };

// One stop, phone-width, with its status buttons (Phase 3). Another technician's stop 404s exactly like a missing one
// (TR-05). Status buttons show only on a stop of the day's current plan (a stop of an older plan is history).
export default async function StopPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const s = await readStop(ctx, (await params).id);
  const day = isoDay(s.plan.date);
  const dispatcher = isDispatcher(ctx.role);
  const back = dispatcher ? `/o/${ctx.slug}/dispatch?date=${day}` : `/o/${ctx.slug}/dispatch/my-day?date=${day}`;
  const status = s.job.status as JobStatus;
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '0 8px', boxSizing: 'border-box', fontSize: 16, overflowWrap: 'anywhere' }}>
      <p><Link href={back}>← Back</Link></p>
      <h1 style={{ fontSize: 24 }}>Job {s.job.ref} <StatusBadge status={status} /></h1>
      <dl>
        <dt>Customer</dt><dd>{s.job.customer}</dd>
        <dt>Address</dt><dd>{s.job.address}</dd>
        <dt>Technician</dt><dd>{s.tech.name}, stop {s.seq}</dd>
        <dt>Planned</dt><dd>arrive {hhmm(s.arrival)}, work {hhmm(s.start)}–{hhmm(s.end)} ({s.driveMin} min drive)</dd>
        <dt>Window</dt><dd>{hhmm(s.job.windowStart)}–{hhmm(s.job.windowEnd)}</dd>
        <dt>Skill · priority</dt><dd>{s.job.skill} · {s.job.priority}</dd>
        {s.job.statusNote && (<><dt>Note</dt><dd>{s.job.statusNote}</dd></>)}
      </dl>
      {s.current ? <StatusButtons slug={ctx.slug} jobId={s.job.id} jobRef={s.job.ref} status={status} back="stop" /> : <p>This stop is from an earlier plan; open the day’s current plan to update it.</p>}
    </main>
  );
}
