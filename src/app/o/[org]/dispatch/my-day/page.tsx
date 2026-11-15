import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ACTIVE, type JobStatus } from '@/lib/dispatch/replan';
import { myDay } from '@/lib/dispatch/tech-day';
import { hhmm, isRealDay, todayIn } from '@/lib/dispatch/time';
import { StatusBadge, StatusButtons } from '../status-buttons';

export const metadata = { title: 'My day' };

// A technician's own day on a phone (PRD §7 Phase 3; TR-05: their stops only). One card per stop in route order, the
// current stop (en route / on site, else the next one not started) marked "Now", and the status buttons on each card.

const card = { listStyle: 'none', border: '1px solid #ccc', borderRadius: 10, padding: 12, margin: '0 0 10px', background: '#fff', overflowWrap: 'anywhere' as const };

export default async function MyDay({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const date = typeof q.date === 'string' && isRealDay(q.date) ? q.date : todayIn();
  const { tech, stops, planId } = await myDay(ctx, date);
  const status = (s: (typeof stops)[number]) => s.job.status as JobStatus;
  const now = stops.find((s) => ACTIVE.includes(status(s))) ?? stops.find((s) => status(s) === 'scheduled');
  const doneCount = stops.filter((s) => status(s) === 'done' || status(s) === 'cant_complete').length;
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '0 8px', boxSizing: 'border-box', fontSize: 16 }}>
      <h1 style={{ fontSize: 24, margin: '12px 0 4px' }}>My day · {date}</h1>
      <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>Day <input type="date" name="date" defaultValue={date} style={{ fontSize: 16 }} /></label>
        <button type="submit" style={{ minHeight: 40, fontSize: 16 }}>Show</button>
      </form>
      {!tech && <p>You are not set up as a technician in this org. Ask your dispatcher to link your login.</p>}
      {tech && !planId && <p>No plan has been saved for this day yet.</p>}
      {tech && planId && stops.length === 0 && <p>No stops for you on this day.</p>}
      {tech && stops.length > 0 && (
        <>
          <p aria-label="Day summary" style={{ margin: '8px 0' }}>
            {tech.name} · {stops.length} stop{stops.length === 1 ? '' : 's'} · {doneCount} finished
          </p>
          <ol aria-label={`Stops for ${tech.name}`} style={{ padding: 0, margin: 0 }}>
            {stops.map((s) => {
              const isNow = now?.id === s.id;
              return (
                <li key={s.id} aria-current={isNow ? 'step' : undefined} style={{ ...card, ...(isNow ? { borderColor: '#1565c0', borderWidth: 2 } : {}) }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 18 }}>
                      {s.seq}. <Link href={`/o/${ctx.slug}/dispatch/stops/${s.id}`}>{s.job.ref}</Link>
                      {isNow && <span style={{ marginLeft: 8, fontSize: 13, color: '#1565c0' }}>Now</span>}
                    </strong>
                    <StatusBadge status={status(s)} />
                  </div>
                  <div style={{ margin: '4px 0' }}>{hhmm(s.start)}–{hhmm(s.end)} · window {hhmm(s.job.windowStart)}–{hhmm(s.job.windowEnd)}</div>
                  <div>{s.job.customer}</div>
                  <div style={{ color: '#555' }}>{s.job.address}</div>
                  <div style={{ color: '#555', fontSize: 14 }}>
                    {s.job.skill} · {s.job.priority === 'emergency' ? <strong style={{ color: '#c62828' }}>emergency</strong> : s.job.priority} · {s.driveMin} min drive
                  </div>
                  {s.job.statusNote && <div style={{ fontSize: 14 }}>Note: {s.job.statusNote}</div>}
                  <StatusButtons slug={ctx.slug} jobId={s.job.id} jobRef={s.job.ref} status={status(s)} back="my-day" />
                </li>
              );
            })}
          </ol>
        </>
      )}
    </main>
  );
}
