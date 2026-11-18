import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import type { JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { readStop } from '@/lib/dispatch/tech-day';
import { isoDay } from '@/lib/dispatch/time';
import { C } from '@/app/ui/theme';
import { PRIORITY_LOOK, clock, dayName, minutes, wall } from '../../look';
import { StatusBadge, StatusButtons } from '../../status-buttons';

export const metadata = { title: 'Stop' };

// One stop, phone-width, with its status buttons (Phase 3), drawn from docs/design/StopDetail.dc.html (gap design,
// D-63). Another technician's stop 404s exactly like a missing one (TR-05). Status buttons show only on a stop of the
// day's current plan (a stop of an older plan is history).
export default async function StopPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const s = await readStop(ctx, (await params).id);
  const day = isoDay(s.plan.date);
  const dispatcher = isDispatcher(ctx.role);
  const back = dispatcher ? `/o/${ctx.slug}/dispatch?date=${day}` : `/o/${ctx.slug}/dispatch/my-day?date=${day}`;
  const status = s.job.status as JobStatus;
  const prio = PRIORITY_LOOK[s.job.priority] ?? PRIORITY_LOOK.standard!;
  const emergency = s.job.priority === 'emergency';
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 0, fontSize: 16 }}>
      <div className="tr-onDark" style={{ background: C.ink, color: '#FFFFFF', padding: '4px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderTop: '1px solid #2A3A48' }}>
        <Link href={back} style={{ color: '#FFFFFF', fontWeight: 600, textDecoration: 'none', minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">←</span> {dispatcher ? 'Back to the board' : 'Back to my day'}
        </Link>
        <span style={{ fontSize: 14, color: C.headLink }}>{s.tech.name} · {dayName(day, true)}</span>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <section aria-labelledby="stop-title" style={{ background: C.card, border: `2px solid ${emergency ? C.red : C.blue}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ alignSelf: 'flex-start', background: emergency ? C.red : C.blue, color: '#FFFFFF', borderRadius: 999, padding: '2px 10px', fontSize: 13, fontWeight: 700 }}>
            {emergency && <span aria-hidden="true">! </span>}{prio.label.toUpperCase()} · STOP {s.seq}
          </span>
          <h1 id="stop-title" style={{ margin: 0, fontSize: 22, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' }}>
            <span>Job {s.job.ref} <span style={{ fontWeight: 600, color: C.text2, fontSize: 18 }}>· {s.job.skill}</span></span> <StatusBadge status={status} />
          </h1>
          <div>
            <div style={{ fontWeight: 600 }}>{s.job.customer}</div>
            <div style={{ color: C.text2 }}>{s.job.address}</div>
            {s.job.customerPhone && <a href={`tel:${s.job.customerPhone}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, fontWeight: 600 }}>Call {s.job.customerPhone}</a>}
          </div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, fontSize: 14 }}>
            <Fact label="Technician" value={`${s.tech.name}, stop ${s.seq}`} />
            <Fact label="Planned arrival" value={clock(s.arrival)} />
            <Fact label="Customer window" value={`${clock(s.job.windowStart)}–${clock(s.job.windowEnd)}`} />
            <Fact label="Work" value={`${clock(s.start)}–${clock(s.end)}`} />
            <Fact label="Drive" value={minutes(s.driveMin)} />
            <Fact label="Slack" value={minutes(s.slackMin)} />
            <Fact label="Estimate" value={minutes(s.job.durationMin)} />
            <Fact label="Priority" value={s.job.priority} />
          </dl>
          {s.job.statusNote && <p style={{ margin: 0, fontSize: 14 }}><strong>Note:</strong> {s.job.statusNote}</p>}
          {s.current ? (
            <>
              <StatusButtons slug={ctx.slug} jobId={s.job.id} jobRef={s.job.ref} status={status} back="stop" />
              <span style={{ fontSize: 13, color: C.text3 }}>Only the next allowed moves are shown. Can’t complete asks for a short note first.</span>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>This stop is from an earlier plan; open the day’s current plan to update it.</p>
          )}
        </section>
        <section aria-labelledby="recorded" style={{ background: C.card, border: `1px solid ${C.cardEdge}`, borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 id="recorded" style={{ margin: 0, fontSize: 17 }}>Recorded</h2>
          {([['En route', s.job.enRouteAt], ['On site', s.job.onSiteAt], [status === 'cant_complete' ? 'Can’t complete' : 'Done', s.job.doneAt]] as const).map(([what, at]) => (
            <div key={what} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14, borderTop: `1px solid ${C.ruleSoft}`, paddingTop: 6 }}>
              <span>{what}</span>
              <span style={{ fontWeight: 700 }}>{wall(at)}</span>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ color: C.text3 }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 700 }}>{value}</dd>
    </div>
  );
}
