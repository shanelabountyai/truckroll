import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Plan as PlanSchema, REASONS } from '@/lib/dispatch/contract';
import { planVsActual, type ActualJob, type PlanMetrics } from '@/lib/dispatch/metrics';
import { STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { dayOf, hhmm, isRealDay, localMinuteOn, todayIn } from '@/lib/dispatch/time';
import { C, btn, card, field, input, td, th } from '@/app/ui/theme';
import { dayName, wall } from '../look';

export const metadata = { title: 'Dispatch metrics' };

const signed = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n} min`);
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
const REASON_LABEL: Record<string, string> = { 'no-skill': 'no skill', 'no-window-fit': 'no window fit', 'over-capacity': 'over capacity' };
const panel = { ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } as const;
const kpi = { ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 } as const;
const small = { ...card, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 150, flex: '1 1 150px' } as const;
const kpiLabel = { fontSize: 13, fontWeight: 600, color: C.text2 } as const;
const kpiValue = { fontSize: 34, fontWeight: 800, lineHeight: 1.1 } as const;
const kpiNote = { fontSize: 13, color: C.text2 } as const;

// PRD §3 "Metrics" (Phase 4), drawn from docs/design/Metrics.dc.html: per plan — on-time %, drive minutes, utilization
// %, unassigned by reason — and plan vs actual once statuses come in (D-57). One day at a time, as the PRD defines it
// (the artboard's "last 30 days" is not built, D-68). Dispatchers only (owner + admin, D-25, D-56); a technician goes
// to My day. Every number comes from the saved plan's metrics or planVsActual; this page only counts and lays out.
export default async function DispatchMetrics({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const date = typeof q.date === 'string' && isRealDay(q.date) ? q.date : todayIn();
  if (!isDispatcher(ctx.role)) redirect(`/o/${ctx.slug}/dispatch/my-day?date=${date}`);

  const data = await withOrg(ctx, async (tx) => {
    const [plans, jobs, techs] = await Promise.all([
      tx.dispatchPlan.findMany({ where: { ...inOrg(ctx), date: dayOf(date) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, createdAt: true, asOf: true, metrics: true, unassignedCount: true, plan: true } }),
      tx.job.findMany({ where: { ...inOrg(ctx), date: dayOf(date) } }),
      tx.technician.findMany({ where: inOrg(ctx), select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    ]);
    const current = plans.at(-1) ?? null;
    const eta = current ? await tx.etaText.groupBy({ by: ['status'], where: { ...inOrg(ctx), planId: current.id }, _count: { _all: true } }) : [];
    return { plans, jobs, techs, current, eta };
  }, { atomic: false });

  const { plans, jobs, current } = data;
  const parsed = current ? PlanSchema.safeParse(current.plan) : null;
  const plan = parsed?.success ? parsed.data : null;
  const metrics = (current?.metrics ?? null) as PlanMetrics | null;
  const actualJobs = new Map<string, ActualJob>(
    jobs.map((j) => [j.id, { status: j.status, windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, onSiteMin: localMinuteOn(j.onSiteAt, date), doneMin: localMinuteOn(j.doneAt, date) }]),
  );
  const pva = plan ? planVsActual(plan, actualJobs) : null;
  const ref = new Map(jobs.map((j) => [j.id, j.ref]));
  const techName = new Map(data.techs.map((t) => [t.id, t.name]));
  const etaCount = (s: string) => data.eta.find((e) => e.status === s)?._count._all ?? 0;

  // Counts only (no new formulas): emergencies on a route vs all of the day's emergencies; per tech, the plan's stops
  // and drive minutes as the solver returned them, and how many recorded arrivals were inside the window.
  const routed = new Set((plan?.routes ?? []).flatMap((r) => r.stops.map((s) => s.jobId)));
  const emergencies = jobs.filter((j) => j.priority === 'emergency');
  const placedEmergencies = emergencies.filter((j) => routed.has(j.id)).length;
  const perTech = (plan?.routes ?? []).filter((r) => r.stops.length).map((r) => {
    const rows = pva?.rows.filter((x) => x.techId === r.techId) ?? [];
    const arrived = rows.filter((x) => x.inWindow !== null);
    return { techId: r.techId, stops: r.stops.length, drive: r.stops.reduce((n, s) => n + s.driveMin, 0) + r.returnDriveMin, arrived: arrived.length, inWindow: arrived.filter((x) => x.inWindow).length };
  }).sort((a, b) => (techName.get(a.techId) ?? '').localeCompare(techName.get(b.techId) ?? ''));
  const maxReason = metrics ? Math.max(1, ...REASONS.map((r) => metrics.unassignedByReason[r] ?? 0)) : 1;
  const topReason = metrics && metrics.unassigned > 0 ? REASONS.reduce((a, b) => ((metrics.unassignedByReason[b] ?? 0) > (metrics.unassignedByReason[a] ?? 0) ? b : a)) : null;

  return (
    <main style={{ maxWidth: 1200, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 24 }}>Metrics · {date}</h1>
          <span style={{ fontSize: 13, color: C.text3 }}>{dayName(date)} · sample data. Plan = what the solver scheduled. Actual = what technicians reported.</span>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <nav aria-label="Dispatch pages" style={{ fontSize: 14, fontWeight: 600 }}>
            <a href={`/o/${ctx.slug}/dispatch?date=${date}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Back to the board</a>
          </nav>
          <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={field}>Day <input type="date" name="date" defaultValue={date} style={input} /></label>
            <button type="submit" style={btn.secondary}>Show</button>
          </form>
        </div>
      </div>

      {!current && <p style={{ ...card, margin: 0, padding: 16 }}>No plan saved for this day, so there is nothing to measure yet.</p>}

      {current && metrics && (
        <section aria-label="Current plan" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Current plan {current.asOf !== null ? `(re-plan as of ${hhmm(current.asOf)})` : ''}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div style={kpi} aria-label="Planned on time">
              <span style={kpiLabel}>Planned on time</span>
              <span style={kpiValue}>{metrics.onTimePct}%</span>
              <span style={kpiNote}>Stops planned to start inside the customer window</span>
            </div>
            <div style={kpi} aria-label="Drive minutes">
              <span style={kpiLabel}>Drive minutes</span>
              <span style={kpiValue}>{metrics.driveMin}</span>
              <span style={kpiNote}>Solver plan, drive home included, across {metrics.techsUsed} tech{metrics.techsUsed === 1 ? '' : 's'}</span>
            </div>
            <div style={kpi} aria-label="Utilization">
              <span style={kpiLabel}>Utilization</span>
              <span style={kpiValue}>{metrics.utilizationPct}%</span>
              <span style={kpiNote}>Job and drive minutes ÷ shift minutes of techs with stops</span>
            </div>
            <div style={kpi} aria-label="Emergencies placed">
              <span style={kpiLabel}>Emergencies placed</span>
              <span style={kpiValue}>{placedEmergencies} of {emergencies.length}</span>
              <span style={kpiNote}>{emergencies.length ? 'Emergency jobs of the day on a route' : 'No emergency jobs on this day'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={small} aria-label="Stops"><span style={kpiLabel}>Stops</span><span><strong style={{ fontSize: 20 }}>{metrics.assigned}</strong> on {metrics.techsUsed} tech{metrics.techsUsed === 1 ? '' : 's'}</span></div>
            <div style={small} aria-label="Unassigned"><span style={kpiLabel}>Unassigned</span><span><strong style={{ fontSize: 20 }}>{metrics.unassigned}</strong></span></div>
            <div style={small} aria-label="ETA texts"><span style={kpiLabel}>ETA texts</span><span><strong style={{ fontSize: 20 }}>{etaCount('sent')}</strong> sent · {etaCount('draft')} draft</span></div>
          </div>
        </section>
      )}

      {current && metrics && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <section aria-labelledby="by-reason" style={{ ...panel, flex: '1 1 420px' }}>
            <h2 id="by-reason" style={{ margin: 0, fontSize: 17 }}>Jobs left unplaced, by reason</h2>
            {REASONS.map((r) => {
              const n = metrics.unassignedByReason[r] ?? 0;
              return (
                <div key={r} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 40px', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{r}</span>
                  <div aria-hidden="true" style={{ height: 18, background: C.ruleSoft, borderRadius: 4 }}>
                    <div style={{ height: 18, width: `${Math.round((100 * n) / maxReason)}%`, background: C.blue, borderRadius: 4 }} />
                  </div>
                  <span style={{ fontWeight: 700, textAlign: 'right' }}>{n}</span>
                </div>
              );
            })}
            <p style={{ margin: 0, fontSize: 13, color: C.text2 }}>
              {topReason ? `${metrics.unassigned} job${metrics.unassigned === 1 ? '' : 's'} left unplaced; the most common reason is ${REASON_LABEL[topReason]} (${metrics.unassignedByReason[topReason]}).` : 'Every job of the day is on a route.'}
            </p>
          </section>
          <section aria-labelledby="per-tech" style={{ ...panel, flex: '1 1 420px', gap: 10 }}>
            <h2 id="per-tech" style={{ margin: 0, fontSize: 17 }}>Plan vs actual, per tech</h2>
            {perTech.length === 0 ? (
              <p style={{ margin: 0, fontSize: 14 }}>No technician has a stop on this plan.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table aria-label="Per technician" style={{ width: '100%', fontSize: 14 }}>
                  <thead>
                    <tr><th scope="col" style={th}>Tech</th><th scope="col" style={{ ...th, textAlign: 'right' }}>Stops</th><th scope="col" style={{ ...th, textAlign: 'right' }}>Drive min (plan)</th><th scope="col" style={{ ...th, textAlign: 'right' }}>Arrived in window (actual)</th></tr>
                  </thead>
                  <tbody>
                    {perTech.map((t) => (
                      <tr key={t.techId}>
                        <td style={{ ...td, fontWeight: 600 }}>{techName.get(t.techId) ?? '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{t.stops}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{t.drive}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{t.arrived ? `${t.inWindow} of ${t.arrived}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ margin: 0, fontSize: 13, color: C.text2 }}>“—” until the technician records an on-site time on this day.</p>
          </section>
        </div>
      )}

      {pva && (
        <section aria-label="Plan vs actual" style={panel}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Plan vs actual</h2>
          {pva.started === 0 ? (
            <p style={{ margin: 0 }}>No technician has recorded a status on this plan yet. Actual times appear here as stops are marked en route, on site and done.</p>
          ) : (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={small} aria-label="Started"><span style={kpiLabel}>Started</span><span><strong style={{ fontSize: 20 }}>{pva.started}</strong> of {pva.stops}</span></div>
              <div style={small} aria-label="Done"><span style={kpiLabel}>Done</span><span><strong style={{ fontSize: 20 }}>{pva.done}</strong>{pva.cantComplete ? ` · ${pva.cantComplete} can’t complete` : ''}</span></div>
              <div style={small} aria-label="Arrived in window"><span style={kpiLabel}>Arrived in window</span><span><strong style={{ fontSize: 20 }}>{pct(pva.actualOnTimePct)}</strong> of {pva.arrived}</span></div>
              <div style={small} aria-label="Average start vs plan"><span style={kpiLabel}>Average start vs plan</span><strong style={{ fontSize: 20 }}>{signed(pva.avgStartDeltaMin)}</strong></div>
              <div style={small} aria-label="Average job length vs estimate"><span style={kpiLabel}>Average job length vs estimate</span><strong style={{ fontSize: 20 }}>{signed(pva.avgDurationDeltaMin)}</strong></div>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table aria-label="Stops, plan vs actual" style={{ fontSize: 14, width: '100%', minWidth: 900 }}>
              <thead>
                <tr>{['Tech', '#', 'Job', 'Status', 'Planned', 'On site', 'Done', 'Start vs plan', 'Length vs estimate', 'In window'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {pva.rows.map((r) => (
                  <tr key={r.jobId} aria-label={`Actual ${ref.get(r.jobId) ?? r.jobId}`}>
                    <td style={td}>{techName.get(r.techId) ?? '—'}</td>
                    <td style={td}>{r.seq}</td>
                    <td style={td}>{ref.get(r.jobId) ?? '—'}</td>
                    <td style={td}>{STATUS_LABEL[r.status as JobStatus] ?? r.status}</td>
                    <td style={td}>{hhmm(r.plannedStart)}–{hhmm(r.plannedEnd)}</td>
                    <td style={td}>{r.actualStart === null ? '—' : hhmm(r.actualStart)}</td>
                    <td style={td}>{r.actualEnd === null ? '—' : hhmm(r.actualEnd)}</td>
                    <td style={td}>{signed(r.startDeltaMin)}</td>
                    <td style={td}>{signed(r.durationDeltaMin)}</td>
                    <td style={td}>{r.inWindow === null ? '—' : r.inWindow ? <><span aria-hidden="true">✓ </span>yes</> : <span style={{ color: C.redDark, fontWeight: 700 }}><span aria-hidden="true">✕ </span>no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {plans.length > 0 && (
        <section aria-label="Plans saved this day" style={panel}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Plans saved this day ({plans.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table aria-label="Plan history" style={{ fontSize: 14, width: '100%', minWidth: 640 }}>
              <thead>
                <tr>{['Saved (Chicago time)', 'Kind', 'Stops', 'Unassigned', 'On time', 'Drive', 'Utilization'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const m = p.metrics as unknown as PlanMetrics;
                  return (
                    <tr key={p.id}>
                      <td style={td}>{wall(p.createdAt)}</td>
                      <td style={td}>{p.asOf === null ? 'plan' : `re-plan as of ${hhmm(p.asOf)}`}{p.id === current?.id ? ' (current)' : ''}</td>
                      <td style={td}>{m.assigned}</td>
                      <td style={td}>{p.unassignedCount}</td>
                      <td style={td}>{m.onTimePct}%</td>
                      <td style={td}>{m.driveMin} min</td>
                      <td style={td}>{m.utilizationPct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
