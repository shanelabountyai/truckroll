import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Plan as PlanSchema, REASONS } from '@/lib/dispatch/contract';
import { planVsActual, type ActualJob, type PlanMetrics } from '@/lib/dispatch/metrics';
import { STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { dayOf, hhmm, isRealDay, localMinuteOn, todayIn } from '@/lib/dispatch/time';

export const metadata = { title: 'Dispatch metrics' };

const cell = { textAlign: 'left' as const, padding: '2px 12px 2px 0', verticalAlign: 'top' as const };
const tile = { border: '1px solid #ccc', borderRadius: 6, padding: '6px 12px', minWidth: 120 } as const;
const signed = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n} min`);
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
const REASON_LABEL: Record<string, string> = { 'no-skill': 'no skill', 'no-window-fit': 'no window fit', 'over-capacity': 'over capacity' };

// PRD §3 "Metrics" (Phase 4): per plan — on-time %, drive minutes, utilization %, unassigned by reason — and plan vs
// actual once statuses come in (D-57). Dispatchers only (owner + admin, D-25, D-56); a technician goes to My day.
export default async function DispatchMetrics({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const date = typeof q.date === 'string' && isRealDay(q.date) ? q.date : todayIn();
  if (!isDispatcher(ctx.role)) redirect(`/o/${ctx.slug}/dispatch/my-day?date=${date}`);

  const data = await withOrg(ctx, async (tx) => {
    const [plans, jobs, techs] = await Promise.all([
      tx.dispatchPlan.findMany({ where: { ...inOrg(ctx), date: dayOf(date) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, createdAt: true, asOf: true, metrics: true, unassignedCount: true, plan: true } }),
      tx.job.findMany({ where: { ...inOrg(ctx), date: dayOf(date) } }),
      tx.technician.findMany({ where: inOrg(ctx), select: { id: true, name: true } }),
    ]);
    const current = plans.at(-1) ?? null;
    const eta = current ? await tx.etaText.groupBy({ by: ['status'], where: { ...inOrg(ctx), planId: current.id }, _count: { _all: true } }) : [];
    return { plans, jobs, techs, current, eta };
  }, { atomic: false });

  const { plans, jobs, current } = data;
  const parsed = current ? PlanSchema.safeParse(current.plan) : null;
  const metrics = (current?.metrics ?? null) as PlanMetrics | null;
  const actualJobs = new Map<string, ActualJob>(
    jobs.map((j) => [j.id, { status: j.status, windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, onSiteMin: localMinuteOn(j.onSiteAt, date), doneMin: localMinuteOn(j.doneAt, date) }]),
  );
  const pva = parsed?.success ? planVsActual(parsed.data, actualJobs) : null;
  const ref = new Map(jobs.map((j) => [j.id, j.ref]));
  const techName = new Map(data.techs.map((t) => [t.id, t.name]));
  const etaCount = (s: string) => data.eta.find((e) => e.status === s)?._count._all ?? 0;

  return (
    <main style={{ maxWidth: 1100 }}>
      <h1>Metrics · {date}</h1>
      <nav aria-label="Dispatch pages" style={{ marginBottom: 8 }}>
        <a href={`/o/${ctx.slug}/dispatch?date=${date}`}>Back to the board</a>
      </nav>
      <form method="get" style={{ marginBottom: '1rem' }}>
        <label>Day <input type="date" name="date" defaultValue={date} /></label> <button type="submit">Show</button>
      </form>

      {!current && <p>No plan saved for this day, so there is nothing to measure yet.</p>}

      {current && metrics && (
        <section aria-label="Current plan">
          <h2>Current plan {current.asOf !== null ? `(re-plan as of ${hhmm(current.asOf)})` : ''}</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={tile} aria-label="Planned on time"><small>Planned on time</small><br /><strong>{metrics.onTimePct}%</strong></div>
            <div style={tile} aria-label="Drive minutes"><small>Drive</small><br /><strong>{metrics.driveMin} min</strong></div>
            <div style={tile} aria-label="Utilization"><small>Utilization</small><br /><strong>{metrics.utilizationPct}%</strong></div>
            <div style={tile} aria-label="Stops"><small>Stops</small><br /><strong>{metrics.assigned}</strong> on {metrics.techsUsed} tech{metrics.techsUsed === 1 ? '' : 's'}</div>
            <div style={tile} aria-label="Unassigned"><small>Unassigned</small><br /><strong>{metrics.unassigned}</strong>{' '}
              {metrics.unassigned > 0 && <small>({REASONS.filter((r) => metrics.unassignedByReason[r]).map((r) => `${metrics.unassignedByReason[r]} ${REASON_LABEL[r]}`).join(', ')})</small>}
            </div>
            <div style={tile} aria-label="ETA texts"><small>ETA texts</small><br /><strong>{etaCount('sent')}</strong> sent · {etaCount('draft')} draft</div>
          </div>
        </section>
      )}

      {pva && (
        <section aria-label="Plan vs actual">
          <h2>Plan vs actual</h2>
          {pva.started === 0 ? (
            <p>No technician has recorded a status on this plan yet. Actual times appear here as stops are marked en route, on site and done.</p>
          ) : (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={tile} aria-label="Started"><small>Started</small><br /><strong>{pva.started}</strong> of {pva.stops}</div>
              <div style={tile} aria-label="Done"><small>Done</small><br /><strong>{pva.done}</strong>{pva.cantComplete ? ` · ${pva.cantComplete} can’t complete` : ''}</div>
              <div style={tile} aria-label="Arrived in window"><small>Arrived in window</small><br /><strong>{pct(pva.actualOnTimePct)}</strong> of {pva.arrived}</div>
              <div style={tile} aria-label="Average start vs plan"><small>Average start vs plan</small><br /><strong>{signed(pva.avgStartDeltaMin)}</strong></div>
              <div style={tile} aria-label="Average job length vs estimate"><small>Average job length vs estimate</small><br /><strong>{signed(pva.avgDurationDeltaMin)}</strong></div>
            </div>
          )}
          <table aria-label="Stops, plan vs actual" style={{ borderCollapse: 'collapse', fontSize: 14, marginTop: 12 }}>
            <thead>
              <tr>{['Tech', '#', 'Job', 'Status', 'Planned', 'On site', 'Done', 'Start vs plan', 'Length vs estimate', 'In window'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {pva.rows.map((r) => (
                <tr key={r.jobId} aria-label={`Actual ${ref.get(r.jobId) ?? r.jobId}`}>
                  <td style={cell}>{techName.get(r.techId) ?? '—'}</td>
                  <td style={cell}>{r.seq}</td>
                  <td style={cell}>{ref.get(r.jobId) ?? '—'}</td>
                  <td style={cell}>{STATUS_LABEL[r.status as JobStatus] ?? r.status}</td>
                  <td style={cell}>{hhmm(r.plannedStart)}–{hhmm(r.plannedEnd)}</td>
                  <td style={cell}>{r.actualStart === null ? '—' : hhmm(r.actualStart)}</td>
                  <td style={cell}>{r.actualEnd === null ? '—' : hhmm(r.actualEnd)}</td>
                  <td style={cell}>{signed(r.startDeltaMin)}</td>
                  <td style={cell}>{signed(r.durationDeltaMin)}</td>
                  <td style={cell}>{r.inWindow === null ? '—' : r.inWindow ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {plans.length > 0 && (
        <section aria-label="Plans saved this day">
          <h2>Plans saved this day ({plans.length})</h2>
          <table aria-label="Plan history" style={{ borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>{['Saved (UTC)', 'Kind', 'Stops', 'Unassigned', 'On time', 'Drive', 'Utilization'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const m = p.metrics as unknown as PlanMetrics;
                return (
                  <tr key={p.id}>
                    <td style={cell}>{p.createdAt.toISOString().slice(11, 16)}</td>
                    <td style={cell}>{p.asOf === null ? 'plan' : `re-plan as of ${hhmm(p.asOf)}`}{p.id === current?.id ? ' (current)' : ''}</td>
                    <td style={cell}>{m.assigned}</td>
                    <td style={cell}>{p.unassignedCount}</td>
                    <td style={cell}>{m.onTimePct}%</td>
                    <td style={cell}>{m.driveMin} min</td>
                    <td style={cell}>{m.utilizationPct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
