import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { PRIORITIES, SKILLS, type Plan } from '@/lib/dispatch/contract';
import type { PlanMetrics } from '@/lib/dispatch/metrics';
import { currentPlan } from '@/lib/dispatch/plan-store';
import { FROZEN, type JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { dayOf, hhmm, isRealDay, nowMinuteIn, todayIn } from '@/lib/dispatch/time';
import { C, btn, card, cardPad, field, input, td, th } from '@/app/ui/theme';
import { addJob, addTech, insertEmergency, pinJob, planDay, replanDay, unpinJob } from './actions';
import { EtaPanel, type EtaRow } from './eta-panel';
import { PRIORITY_LOOK, PriorityTag, StatusBadge, clock, dayName, plural, wall } from './look';
import { DayTimeline, Legend, StopsTable, type StopJob } from './timeline';

export const metadata = { title: 'Dispatch' };

// Why a job is unassigned, for the dispatcher. Jobs are scheduled only inside their window (D-36), never late.
const REASON_TEXT: Record<string, string> = {
  'no-skill': 'no technician has the skill',
  'no-window-fit': 'no technician can get there inside its window',
  'over-capacity': 'no route has room for it inside its window',
};

const notice = { margin: 0, background: C.card, border: `1px solid ${C.cardEdge}`, borderLeft: `4px solid ${C.blue}`, borderRadius: 8, padding: '10px 14px' } as const;
const section = { ...card, overflow: 'hidden' } as const;
const sectionHead = { padding: '14px 16px', borderBottom: `1px solid ${C.rule}`, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center' } as const;
const fieldGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, margin: '8px 0' } as const;
const help = { fontSize: 13, color: C.text2 } as const;

// The dispatcher board (PRD §7 Phases 2–4), drawn from docs/design/Main.dc.html (timeline, not-placed list, ETA texts)
// and the gap design BoardTools.dc.html (day bar, Plan the day, re-plan, emergency insert, jobs and pins, technicians,
// add forms). Business rules live in actions.ts and src/lib/dispatch; this file only lays them out.
export default async function DispatchBoard({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const asked = typeof q.date === 'string' ? q.date : '';
  const date = isRealDay(asked) ? asked : todayIn();
  if (!isDispatcher(ctx.role)) redirect(`/o/${ctx.slug}/dispatch/my-day?date=${date}`);

  const { techs, jobs, saved, members, stopIds, etas } = await withOrg(ctx, async (tx) => {
    const [techs, jobs, saved, members] = await Promise.all([
      tx.technician.findMany({ where: inOrg(ctx), orderBy: [{ name: 'asc' }, { id: 'asc' }], include: { user: { select: { email: true } } } }),
      tx.job.findMany({ where: { ...inOrg(ctx), date: dayOf(date) }, orderBy: [{ ref: 'asc' }, { id: 'asc' }] }),
      currentPlan(tx, ctx.orgId, date),
      tx.membership.findMany({ where: { ...inOrg(ctx), role: 'member' }, include: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const stops = saved ? await tx.planStop.findMany({ where: { ...inOrg(ctx), planId: saved.id }, select: { id: true, jobId: true } }) : [];
    const texts = saved ? await tx.etaText.findMany({ where: { ...inOrg(ctx), planId: saved.id, status: { in: ['draft', 'sent'] } }, include: { job: { select: { ref: true, customer: true } } }, orderBy: [{ job: { ref: 'asc' } }] }) : [];
    const approvers = new Map((await tx.user.findMany({ where: { id: { in: texts.map((t) => t.approvedById).filter((x): x is string => !!x) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
    const etas: EtaRow[] = texts.map((t) => ({ id: t.id, jobRef: t.job.ref, customer: t.job.customer, phone: t.phone, body: t.body, source: t.source, fallbackReason: t.fallbackReason, status: t.status, editedAt: t.editedAt, sentAt: t.sentAt, approvedBy: t.approvedById ? approvers.get(t.approvedById) ?? null : null }));
    return { techs, jobs, saved, members, stopIds: new Map(stops.map((x) => [x.jobId, x.id])), etas };
  }, { atomic: false });

  const plan = (saved?.plan ?? null) as Plan | null;
  const metrics = (saved?.metrics ?? null) as PlanMetrics | null;
  const techName = new Map(techs.map((t) => [t.id, t.name]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const jobInfo = new Map<string, StopJob>(jobs.map((j) => [j.id, j]));
  const assignedTo = new Map<string, { techId: string; seq: number }>();
  for (const r of plan?.routes ?? []) for (const s of r.stops) assignedTo.set(s.jobId, { techId: r.techId, seq: s.seq });
  const reasons = new Map((plan?.unassigned ?? []).map((u) => [u.jobId, u.reasons]));
  const scale = techs.length ? { from: Math.min(...techs.map((t) => t.shiftStart)) - 30, to: Math.max(...techs.map((t) => t.shiftEnd)) + 30 } : { from: 420, to: 1080 };
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const linked = new Set(techs.map((t) => t.userId).filter(Boolean));
  const started = jobs.filter((j) => FROZEN.includes(j.status as JobStatus)).length;
  const isToday = date === todayIn();
  const asOfDefault = isToday ? hhmm(nowMinuteIn()) : '';
  const unplacedEmergencies = (plan?.unassigned ?? []).filter((u) => jobInfo.get(u.jobId)?.priority === 'emergency');
  const num = (k: string) => (typeof q[k] === 'string' && /^\d{1,4}$/.test(q[k] as string) ? Number(q[k]) : null);
  const etaFlash = num('sent') !== null ? `${num('sent')} ETA text${num('sent') === 1 ? '' : 's'} approved and sent (captured, not texted).` : num('drafted') !== null ? `${num('drafted')} ETA draft${num('drafted') === 1 ? '' : 's'} ready for review. Nothing has been sent.` : null;
  const replannedAt = typeof q.replanned === 'string' && /^\d{4}$/.test(q.replanned) ? `${q.replanned.slice(0, 2)}:${q.replanned.slice(2)}` : null;
  const placed = plan ? plan.routes.reduce((n, r) => n + r.stops.length, 0) : 0;
  const stopHref = (jobId: string) => (stopIds.has(jobId) ? `/o/${ctx.slug}/dispatch/stops/${stopIds.get(jobId)}` : null);

  return (
    <main style={{ maxWidth: 1400, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline' }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Dispatch · {date}</h1>
          <nav aria-label="Dispatch pages" style={{ fontSize: 14, fontWeight: 600 }}>
            <a href={`/o/${ctx.slug}/dispatch/metrics?date=${date}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Metrics for {date}</a>
          </nav>
        </div>
        <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label style={field}>Day <input type="date" name="date" defaultValue={date} style={input} /></label>
          <button type="submit" style={btn.secondary}>Show</button>
        </form>
      </div>

      {q.saved === '1' && saved && plan && <p role="status" style={notice}>Plan saved: {placed} stops, {saved.unassignedCount} unassigned.</p>}
      {replannedAt && saved && plan && saved.asOf !== null && (
        <p role="status" style={notice}>Re-plan saved as of {replannedAt}: {placed} stops, {saved.unassignedCount} unassigned. Started jobs and pins were kept.</p>
      )}

      {unplacedEmergencies.length > 0 && (
        <div role="alert" aria-label="Unplaced emergencies" className="tr-onDark" style={{ background: C.red, color: '#FFFFFF', borderRadius: 12, padding: '14px 18px', display: 'flex', flexWrap: 'wrap', gap: '12px 20px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1, fontWeight: 800 }}>!</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong style={{ fontSize: 17 }}>{unplacedEmergencies.length === 1 ? 'An emergency could not be placed' : `${unplacedEmergencies.length} emergencies could not be placed`}.</strong>
              {unplacedEmergencies.map((u) => {
                const j = jobInfo.get(u.jobId);
                return (
                  <span key={u.jobId} style={{ fontSize: 14, color: C.redTint }}>
                    Job {j?.ref ?? 'removed'}{j ? ` · ${j.customer} (window ends ${clock(j.windowEnd)})` : ''}: <strong>{u.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}</strong>.
                  </span>
                );
              })}
              <span style={{ fontSize: 14, color: C.redTint }}>Pinned jobs and started work are never moved to make room (D-37). To put the emergency first, unpin a job or change its window, then re-plan.</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href="#jobs" style={{ ...btn.primary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', background: '#FFFFFF', color: C.redDark, border: '2px solid #FFFFFF', boxSizing: 'border-box' }}>Review pins</a>
            {plan && <a href="#replan" style={{ ...btn.primary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', background: 'transparent', color: '#FFFFFF', border: '2px solid #FFFFFF', boxSizing: 'border-box' }}>Re-plan</a>}
            {unplacedEmergencies.map((u) => jobById.get(u.jobId)?.customerPhone).filter(Boolean).slice(0, 1).map((phone) => (
              <a key={phone} href={`tel:${phone}`} style={{ ...btn.primary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', background: 'transparent', color: '#FFFFFF', border: '2px solid #FFFFFF', boxSizing: 'border-box' }}>Call customer</a>
            ))}
          </div>
        </div>
      )}

      {started === 0 ? (
        <section aria-labelledby="plan-day" style={{ ...cardPad, display: 'flex', flexWrap: 'wrap', gap: '10px 20px', alignItems: 'center' }}>
          <h2 id="plan-day" style={{ margin: 0, fontSize: 16, flexBasis: '100%' }}>{plan ? 'Plan the day again' : 'Plan the day'}</h2>
          <ActionForm action={bind(planDay)}>
            <input type="hidden" name="date" value={date} />
            <button type="submit" disabled={!jobs.length || !techs.length} style={{ ...btn.primary, minHeight: 48, fontSize: 16, padding: '0 20px' }}>Plan the day</button>
          </ActionForm>
          <span style={{ ...help, flex: '1 1 420px' }}>
            {!jobs.length || !techs.length ? `Add ${!techs.length ? 'technicians' : ''}${!techs.length && !jobs.length ? ' and ' : ''}${!jobs.length ? 'jobs for this day' : ''} below first. ` : ''}
            Pinned jobs never move: each is planned on its pinned tech, at its pinned position if it has one. If the pins can&apos;t all be kept, nothing is planned and you are told which pins to change. Jobs are scheduled only inside their window; a job no tech can reach in its window stays unassigned. Every plan is checked before it is saved.
          </span>
        </section>
      ) : (
        <p style={{ ...notice, borderLeft: `4px solid ${C.amberMid}` }}>
          Work has started on this day ({started} job{started === 1 ? '' : 's'} en route, on site or finished), so it is re-planned from a time instead of planned from scratch. <a href="#replan">Go to Mid-day re-plan</a>
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <section aria-labelledby="tl" style={{ ...section, flex: '999 1 820px', minWidth: 0 }}>
          <div style={sectionHead}>
            <h2 id="tl" style={{ margin: 0, fontSize: 19 }}>{dayName(date)} · {plural(techs.length, 'tech')} · {placed} jobs placed</h2>
            <Legend />
          </div>
          {!plan && <p style={{ margin: 0, padding: 16 }}>No plan saved for this day yet.</p>}
          {plan && metrics && (
            <p aria-label="Plan summary" style={{ margin: 0, padding: '10px 16px 0', fontSize: 14, color: C.text2 }}>
              {saved!.asOf !== null ? `Re-plan as of ${hhmm(saved!.asOf)} · ` : ''}Saved {wall(saved!.createdAt)} · on time {metrics.onTimePct}% · drive {metrics.driveMin} min · utilization {metrics.utilizationPct}% ·{' '}
              <strong style={{ color: plan.unassigned.length ? C.red : C.ink }}>{plan.unassigned.length} unassigned</strong>
            </p>
          )}
          {plan && <DayTimeline techs={techs} routes={plan.routes} jobs={jobInfo} scale={scale} now={isToday ? nowMinuteIn() : null} stopHref={stopHref} />}
        </section>

        <aside aria-label="Needs attention" style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {plan && (
            <section aria-labelledby="unplaced" style={{ ...cardPad, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h2 id="unplaced" style={{ margin: 0, fontSize: 16 }}>Not placed ({plan.unassigned.length})</h2>
              {plan.unassigned.length === 0 && <p style={{ margin: '6px 0 0', ...help }}>Every job of the day is on a route.</p>}
              {plan.unassigned.length > 0 && (
                <ul aria-label="Unassigned jobs" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {plan.unassigned.map((u) => {
                    const j = jobInfo.get(u.jobId);
                    const prio = PRIORITY_LOOK[j?.priority ?? 'standard'] ?? PRIORITY_LOOK.standard!;
                    return (
                      <li key={u.jobId} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 0', borderTop: `1px solid ${C.ruleSoft}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontWeight: 600 }}>{j ? `Job ${j.ref} · ${j.skill}` : 'removed job'}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: prio.color, whiteSpace: 'nowrap' }}><span aria-hidden="true">{prio.glyph} </span>{prio.label.toUpperCase()}</span>
                        </div>
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {u.reasons.map((r) => <span key={r} style={{ fontSize: 12, fontWeight: 700, color: C.text2, border: `1px solid ${C.control}`, borderRadius: 6, padding: '0 6px' }}>{r}</span>)}
                        </span>
                        <span style={{ fontSize: 13, color: C.text2 }}>
                          {u.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}{j ? `. Window ${clock(j.windowStart)}–${clock(j.windowEnd)}.` : '.'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          {plan && <EtaPanel slug={ctx.slug} date={date} rows={etas} aiConfigured={!!process.env.ANTHROPIC_API_KEY?.trim()} flash={etaFlash} />}
          {!plan && <p style={{ ...cardPad, margin: 0, ...help }}>Unplaced jobs and customer ETA texts show here once the day is planned.</p>}
        </aside>
      </div>

      {plan && (
        <section id="replan" aria-label="Re-plan" style={{ ...cardPad, display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Mid-day re-plan</h2>
          <ActionForm action={bind(replanDay)}>
            <input type="hidden" name="date" value={date} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
              <label style={field}>Re-plan from <input name="asOf" type="time" required defaultValue={asOfDefault} style={input} /></label>
              <button type="submit" style={btn.primary}>Re-plan</button>
              <span style={{ ...help, flex: '1 1 360px' }}>
                Jobs en route, on site, done or can&apos;t-complete stay exactly where they are; each technician starts from their current job (or the last one they finished, or home) as their statuses say. A stop nobody marked counts as not started. Pins are kept; an emergency never displaces a pin.
              </span>
            </div>
          </ActionForm>
          <details style={{ borderTop: `1px solid ${C.ruleSoft}`, paddingTop: 6 }}>
            <summary style={{ color: C.red }}><span aria-hidden="true">!</span> Emergency insert</summary>
            <ActionForm action={bind(insertEmergency)}>
              <input type="hidden" name="date" value={date} />
              <div style={fieldGrid}>
                <label style={field}>Re-plan from <input name="asOf" type="time" required defaultValue={asOfDefault} aria-label="Emergency re-plan time" style={input} /></label>
                <label style={field}>Window end <input name="windowEnd" type="time" required defaultValue="14:00" aria-label="Emergency window end" style={input} /></label>
                <label style={field}>Duration (min) <input name="durationMin" type="number" min={1} max={720} required defaultValue={60} aria-label="Emergency duration" style={input} /></label>
                <label style={field}>Job number <input name="ref" required maxLength={32} aria-label="Emergency job number" style={input} /></label>
                <label style={field}>Customer <input name="customer" required maxLength={120} aria-label="Emergency customer" style={input} /></label>
                <label style={field}>Address <input name="address" required maxLength={200} aria-label="Emergency address" style={input} /></label>
                <label style={field}>Phone <input name="customerPhone" type="tel" maxLength={32} aria-label="Emergency phone" style={input} /></label>
                <label style={field}>Latitude <input name="lat" required inputMode="decimal" aria-label="Emergency latitude" style={input} /></label>
                <label style={field}>Longitude <input name="lng" required inputMode="decimal" aria-label="Emergency longitude" style={input} /></label>
                <label style={field}>Skill <select name="skill" defaultValue="repair" aria-label="Emergency skill" style={input}>{SKILLS.map((x) => <option key={x}>{x}</option>)}</select></label>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button type="submit" style={btn.danger}>Add emergency and re-plan</button>
                <span style={help}>The window opens at the re-plan time. The job is added first; if the re-plan can&apos;t be saved, it stays on the board unassigned and you are told why.</span>
              </div>
            </ActionForm>
          </details>
        </section>
      )}

      {plan && (
        <section aria-labelledby="by-tech" style={{ ...cardPad, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 id="by-tech" style={{ margin: 0, fontSize: 16 }}>Stops by technician</h2>
          {techs.map((t) => (
            <StopsTable key={t.id} name={t.name} route={plan.routes.find((r) => r.techId === t.id) ?? null} jobs={jobInfo} stopHref={stopHref} />
          ))}
        </section>
      )}

      <section id="jobs" aria-labelledby="jobs-h" style={{ ...section, scrollMarginTop: 12 }}>
        <div style={sectionHead}><h2 id="jobs-h" style={{ margin: 0, fontSize: 16 }}>Jobs ({jobs.length})</h2></div>
        {jobs.length === 0 && <p style={{ margin: 0, padding: 16 }}>No jobs on this day yet. Use Add a job below.</p>}
        <div style={{ overflowX: 'auto', padding: '0 16px 8px' }}>
          <table aria-label="Jobs" style={{ fontSize: 14, width: '100%', minWidth: 1040 }}>
            <thead>
              <tr>{['Job', 'Customer', 'Window', 'Duration', 'Skill', 'Priority', 'Status', 'Planned', 'Pin'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const a = assignedTo.get(j.id);
                return (
                  <tr key={j.id} aria-label={`Job ${j.ref}`}>
                    <td style={{ ...td, fontWeight: 700 }}>{stopHref(j.id) ? <a href={stopHref(j.id)!}>{j.ref}</a> : j.ref}</td>
                    <td style={td}>{j.customer}<br /><span style={{ fontSize: 12, color: C.text3 }}>{j.address}{j.customerPhone ? ` · ${j.customerPhone}` : ''}</span></td>
                    <td style={td}>{hhmm(j.windowStart)}–{hhmm(j.windowEnd)}</td>
                    <td style={td}>{j.durationMin} min</td>
                    <td style={td}>{j.skill}</td>
                    <td style={td}><PriorityTag priority={j.priority} /></td>
                    <td style={td}><StatusBadge status={j.status as JobStatus} /></td>
                    <td style={td}>{a ? `${techName.get(a.techId)} #${a.seq}` : reasons.get(j.id)?.join(', ') ?? '—'}</td>
                    <td style={{ ...td, paddingTop: 5, paddingBottom: 5 }}>
                      {FROZEN.includes(j.status as JobStatus) ? (
                        <span style={{ color: C.text2 }}>{j.pinTechId ? `Pinned to ${techName.get(j.pinTechId)}${j.pinPosition ? ` at #${j.pinPosition}` : ''} · started` : 'started'}</span>
                      ) : j.pinTechId ? (
                        <ActionForm action={bind(unpinJob)}>
                          <input type="hidden" name="id" value={j.id} />
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span><strong>PIN</strong> Pinned to {techName.get(j.pinTechId)}{j.pinPosition ? ` at #${j.pinPosition}` : ''}</span>
                            <button type="submit" aria-label={`Unpin ${j.ref}`} style={btn.secondary}>Unpin</button>
                          </span>
                        </ActionForm>
                      ) : (
                        <ActionForm action={bind(pinJob)}>
                          <input type="hidden" name="id" value={j.id} />
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <select name="techId" aria-label={`Pin ${j.ref} to`} defaultValue="" style={input}>
                              <option value="" disabled>Tech…</option>
                              {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <input name="position" type="number" min={1} max={50} placeholder="#" aria-label={`Position for ${j.ref}`} style={{ ...input, width: 56 }} />
                            <button type="submit" aria-label={`Pin ${j.ref}`} style={btn.outline}>Pin</button>
                          </span>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="techs-h" style={section}>
        <div style={sectionHead}><h2 id="techs-h" style={{ margin: 0, fontSize: 16 }}>Technicians ({techs.length})</h2></div>
        {techs.length === 0 && <p style={{ margin: 0, padding: 16 }}>No technicians yet. Use Add a technician below.</p>}
        <div style={{ overflowX: 'auto', padding: '0 16px 8px' }}>
          <table aria-label="Technicians" style={{ fontSize: 14, width: '100%', minWidth: 720 }}>
            <thead>
              <tr>{['Name', 'Skills', 'Shift', 'Lunch window', 'Max jobs', 'Login'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {techs.map((t) => (
                <tr key={t.id}>
                  <td style={{ ...td, fontWeight: 700 }}>{t.name}</td>
                  <td style={td}>{t.skills.join(' · ')}</td>
                  <td style={td}>{hhmm(t.shiftStart)}–{hhmm(t.shiftEnd)}</td>
                  <td style={td}>{hhmm(t.lunchEarliest)}–{hhmm(t.lunchLatest)}</td>
                  <td style={td}>{t.maxJobs}</td>
                  <td style={td}>{t.user?.email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <details style={{ ...card, flex: '1 1 420px', padding: '4px 16px' }}>
          <summary>Add a job</summary>
          <ActionForm action={bind(addJob)}>
            <input type="hidden" name="date" value={date} />
            <div style={fieldGrid}>
              <label style={field}>Job number <input name="ref" required maxLength={32} style={input} /></label>
              <label style={field}>Customer <input name="customer" required maxLength={120} style={input} /></label>
              <label style={field}>Address <input name="address" required maxLength={200} style={input} /></label>
              <label style={field}>Phone <input name="customerPhone" type="tel" maxLength={32} style={input} /></label>
              <label style={field}>Latitude <input name="lat" required inputMode="decimal" style={input} /></label>
              <label style={field}>Longitude <input name="lng" required inputMode="decimal" style={input} /></label>
              <label style={field}>Window start <input name="windowStart" type="time" required defaultValue="08:00" style={input} /></label>
              <label style={field}>Window end <input name="windowEnd" type="time" required defaultValue="12:00" style={input} /></label>
              <label style={field}>Duration (min) <input name="durationMin" type="number" min={1} max={720} required defaultValue={60} style={input} /></label>
              <label style={field}>Skill <select name="skill" defaultValue="repair" style={input}>{SKILLS.map((s) => <option key={s}>{s}</option>)}</select></label>
              <label style={field}>Priority <select name="priority" defaultValue="standard" style={input}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
            </div>
            <p style={{ margin: '0 0 12px' }}><button type="submit" style={btn.primary}>Add job</button></p>
          </ActionForm>
        </details>

        <details style={{ ...card, flex: '1 1 420px', padding: '4px 16px' }}>
          <summary>Add a technician</summary>
          <ActionForm action={bind(addTech)}>
            <input type="hidden" name="date" value={date} />
            <div style={fieldGrid}>
              <label style={field}>Name <input name="name" required maxLength={120} style={input} /></label>
            </div>
            <fieldset style={{ border: `1px solid ${C.cardEdge}`, borderRadius: 8, padding: '6px 12px 10px', margin: '0 0 8px' }}>
              <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 4px' }}>Skills</legend>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
                {SKILLS.map((s) => <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input type="checkbox" name="skills[]" value={s} /> {s}</label>)}
              </span>
            </fieldset>
            <div style={fieldGrid}>
              <label style={field}>Shift start <input name="shiftStart" type="time" required defaultValue="08:00" style={input} /></label>
              <label style={field}>Shift end <input name="shiftEnd" type="time" required defaultValue="17:00" style={input} /></label>
              <label style={field}>Lunch earliest <input name="lunchEarliest" type="time" required defaultValue="11:30" style={input} /></label>
              <label style={field}>Lunch latest <input name="lunchLatest" type="time" required defaultValue="13:00" style={input} /></label>
              <label style={field}>Home latitude <input name="homeLat" required inputMode="decimal" style={input} /></label>
              <label style={field}>Home longitude <input name="homeLng" required inputMode="decimal" style={input} /></label>
              <label style={field}>Max jobs <input name="maxJobs" type="number" min={0} max={50} required defaultValue={8} style={input} /></label>
              <label style={field}>Login{' '}
                <select name="userId" defaultValue="" style={input}>
                  <option value="">No login</option>
                  {members.filter((m) => !linked.has(m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.user.email}</option>)}
                </select>
              </label>
            </div>
            <p style={{ margin: '0 0 12px' }}><button type="submit" style={btn.primary}>Add technician</button></p>
          </ActionForm>
        </details>
      </div>
    </main>
  );
}
