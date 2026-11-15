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
import { addJob, addTech, insertEmergency, pinJob, planDay, replanDay, unpinJob } from './actions';
import { EtaPanel, type EtaRow } from './eta-panel';
import { TechTimeline, type StopJob } from './timeline';

export const metadata = { title: 'Dispatch' };

const cell = { textAlign: 'left' as const, padding: '2px 10px 2px 0', verticalAlign: 'top' as const };

// Why a job is unassigned, for the dispatcher. Jobs are scheduled only inside their window (D-36), never late.
const REASON_TEXT: Record<string, string> = {
  'no-skill': 'no technician has the skill',
  'no-window-fit': 'no technician can get there inside its window',
  'over-capacity': 'no route has room for it inside its window',
};

// The dispatcher board (PRD §7 Phases 2–3): the day's jobs with pins and statuses, the technicians, Plan the day,
// Re-plan from a time and Emergency insert (Phase 3), and the current plan as one timeline per technician.
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

  return (
    <main style={{ maxWidth: 1200 }}>
      <h1>Dispatch · {date}</h1>
      <nav aria-label="Dispatch pages" style={{ marginBottom: 8 }}>
        <a href={`/o/${ctx.slug}/dispatch/metrics?date=${date}`}>Metrics for {date}</a>
      </nav>
      <form method="get" style={{ marginBottom: '1rem' }}>
        <label>Day <input type="date" name="date" defaultValue={date} /></label> <button type="submit">Show</button>
      </form>
      {q.saved === '1' && saved && plan && <p role="status">Plan saved: {plan.routes.reduce((n, r) => n + r.stops.length, 0)} stops, {saved.unassignedCount} unassigned.</p>}
      {replannedAt && saved && plan && saved.asOf !== null && (
        <p role="status">Re-plan saved as of {replannedAt}: {plan.routes.reduce((n, r) => n + r.stops.length, 0)} stops, {saved.unassignedCount} unassigned. Started jobs and pins were kept.</p>
      )}
      {unplacedEmergencies.length > 0 && (
        <div role="alert" aria-label="Unplaced emergencies" style={{ border: '2px solid #c62828', borderRadius: 6, padding: '8px 12px', margin: '8px 0' }}>
          <strong>{unplacedEmergencies.length === 1 ? 'An emergency could not be placed' : `${unplacedEmergencies.length} emergencies could not be placed`}.</strong>{' '}
          {unplacedEmergencies.map((u) => `Job ${jobInfo.get(u.jobId)?.ref ?? 'removed'}: ${u.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}.`).join(' ')}{' '}
          Pinned jobs and started work are never moved to make room (D-37). To put the emergency first, unpin a job or change its window, then re-plan.
        </div>
      )}

      {started === 0 ? (
        <ActionForm action={bind(planDay)}>
          <input type="hidden" name="date" value={date} />
          <button type="submit" disabled={!jobs.length || !techs.length}>Plan the day</button>{' '}
          <small>
            Pinned jobs never move: each is planned on its pinned tech, at its pinned position if it has one. If the pins can&apos;t all be kept, nothing is planned and you are told which pins to change. Jobs are scheduled only inside their window; a job no tech can reach in its window stays unassigned. Every plan is checked before it is saved.
          </small>
        </ActionForm>
      ) : (
        <p><small>Work has started on this day ({started} job{started === 1 ? '' : 's'} en route, on site or finished), so it is re-planned from a time instead of planned from scratch.</small></p>
      )}

      {plan && (
        <section aria-label="Re-plan" style={{ margin: '1rem 0', padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6 }}>
          <h2 style={{ marginTop: 0 }}>Mid-day re-plan</h2>
          <ActionForm action={bind(replanDay)}>
            <input type="hidden" name="date" value={date} />
            <label>Re-plan from <input name="asOf" type="time" required defaultValue={asOfDefault} /></label>{' '}
            <button type="submit">Re-plan</button>{' '}
            <small>
              Jobs en route, on site, done or can&apos;t-complete stay exactly where they are; each technician starts from their current job (or the last one they finished, or home) as their statuses say. A stop nobody marked counts as not started. Pins are kept; an emergency never displaces a pin.
            </small>
          </ActionForm>
          <details style={{ marginTop: 8 }}>
            <summary>Emergency insert</summary>
            <ActionForm action={bind(insertEmergency)}>
              <input type="hidden" name="date" value={date} />
              <p>
                <label>Re-plan from <input name="asOf" type="time" required defaultValue={asOfDefault} aria-label="Emergency re-plan time" /></label>{' '}
                <label>Window end <input name="windowEnd" type="time" required defaultValue="14:00" aria-label="Emergency window end" /></label>{' '}
                <label>Duration (min) <input name="durationMin" type="number" min={1} max={720} required defaultValue={60} aria-label="Emergency duration" /></label>
              </p>
              <p>
                <label>Job number <input name="ref" required maxLength={32} aria-label="Emergency job number" /></label>{' '}
                <label>Customer <input name="customer" required maxLength={120} aria-label="Emergency customer" /></label>{' '}
                <label>Address <input name="address" required maxLength={200} aria-label="Emergency address" /></label>{' '}
                <label>Phone <input name="customerPhone" type="tel" maxLength={32} aria-label="Emergency phone" /></label>
              </p>
              <p>
                <label>Latitude <input name="lat" required inputMode="decimal" aria-label="Emergency latitude" /></label>{' '}
                <label>Longitude <input name="lng" required inputMode="decimal" aria-label="Emergency longitude" /></label>{' '}
                <label>Skill <select name="skill" defaultValue="repair" aria-label="Emergency skill">{SKILLS.map((x) => <option key={x}>{x}</option>)}</select></label>
              </p>
              <button type="submit">Add emergency and re-plan</button>{' '}
              <small>The window opens at the re-plan time. The job is added first; if the re-plan can&apos;t be saved, it stays on the board unassigned and you are told why.</small>
            </ActionForm>
          </details>
        </section>
      )}

      {plan && <EtaPanel slug={ctx.slug} date={date} rows={etas} aiConfigured={!!process.env.ANTHROPIC_API_KEY?.trim()} flash={etaFlash} />}

      <h2>Plan</h2>
      {!plan && <p>No plan saved for this day yet.</p>}
      {plan && metrics && (
        <>
          <p aria-label="Plan summary">
            {saved!.asOf !== null ? `Re-plan as of ${hhmm(saved!.asOf)} · ` : ''}Saved {saved!.createdAt.toISOString().slice(11, 16)} UTC · on time {metrics.onTimePct}% · drive {metrics.driveMin} min · utilization {metrics.utilizationPct}% ·{' '}
            <strong>{plan.unassigned.length} unassigned</strong>
          </p>
          {techs.map((t) => (
            <TechTimeline
              key={t.id}
              name={t.name}
              shiftStart={t.shiftStart}
              shiftEnd={t.shiftEnd}
              route={plan.routes.find((r) => r.techId === t.id) ?? null}
              jobs={jobInfo}
              scale={scale}
              stopHref={(jobId) => (stopIds.has(jobId) ? `/o/${ctx.slug}/dispatch/stops/${stopIds.get(jobId)}` : null)}
            />
          ))}
          {plan.unassigned.length > 0 && (
            <section aria-label="Unassigned jobs">
              <h3>Unassigned</h3>
              <ul>
                {plan.unassigned.map((u) => (
                  <li key={u.jobId}>
                    {jobInfo.get(u.jobId)?.ref ?? 'removed job'} — {u.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <h2>Jobs ({jobs.length})</h2>
      <table aria-label="Jobs" style={{ borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {['Job', 'Customer', 'Window', 'Duration', 'Skill', 'Priority', 'Status', 'Planned', 'Pin'].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const a = assignedTo.get(j.id);
            return (
              <tr key={j.id} aria-label={`Job ${j.ref}`}>
                <td style={cell}>{j.ref}</td>
                <td style={cell}>{j.customer}<br /><small>{j.address}{j.customerPhone ? ` · ${j.customerPhone}` : ''}</small></td>
                <td style={cell}>{hhmm(j.windowStart)}–{hhmm(j.windowEnd)}</td>
                <td style={cell}>{j.durationMin} min</td>
                <td style={cell}>{j.skill}</td>
                <td style={cell}>{j.priority}</td>
                <td style={cell}>{j.status.replace('_', ' ')}</td>
                <td style={cell}>{a ? `${techName.get(a.techId)} #${a.seq}` : reasons.get(j.id)?.join(', ') ?? '—'}</td>
                <td style={cell}>
                  {FROZEN.includes(j.status as JobStatus) ? (
                    j.pinTechId ? `Pinned to ${techName.get(j.pinTechId)}${j.pinPosition ? ` at #${j.pinPosition}` : ''} · started` : 'started'
                  ) : j.pinTechId ? (
                    <ActionForm action={bind(unpinJob)}>
                      <input type="hidden" name="id" value={j.id} />
                      Pinned to {techName.get(j.pinTechId)}{j.pinPosition ? ` at #${j.pinPosition}` : ''} <button type="submit" aria-label={`Unpin ${j.ref}`}>Unpin</button>
                    </ActionForm>
                  ) : (
                    <ActionForm action={bind(pinJob)}>
                      <input type="hidden" name="id" value={j.id} />
                      <select name="techId" aria-label={`Pin ${j.ref} to`} defaultValue="">
                        <option value="" disabled>Tech…</option>
                        {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>{' '}
                      <input name="position" type="number" min={1} max={50} placeholder="#" aria-label={`Position for ${j.ref}`} style={{ width: 48 }} />{' '}
                      <button type="submit" aria-label={`Pin ${j.ref}`}>Pin</button>
                    </ActionForm>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Technicians ({techs.length})</h2>
      <table aria-label="Technicians" style={{ borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>{['Name', 'Skills', 'Shift', 'Lunch window', 'Max jobs', 'Login'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {techs.map((t) => (
            <tr key={t.id}>
              <td style={cell}>{t.name}</td>
              <td style={cell}>{t.skills.join(', ')}</td>
              <td style={cell}>{hhmm(t.shiftStart)}–{hhmm(t.shiftEnd)}</td>
              <td style={cell}>{hhmm(t.lunchEarliest)}–{hhmm(t.lunchLatest)}</td>
              <td style={cell}>{t.maxJobs}</td>
              <td style={cell}>{t.user?.email ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <details style={{ marginTop: '1rem' }}>
        <summary>Add a job</summary>
        <ActionForm action={bind(addJob)}>
          <input type="hidden" name="date" value={date} />
          <p>
            <label>Job number <input name="ref" required maxLength={32} /></label>{' '}
            <label>Customer <input name="customer" required maxLength={120} /></label>{' '}
            <label>Address <input name="address" required maxLength={200} /></label>{' '}
            <label>Phone <input name="customerPhone" type="tel" maxLength={32} /></label>
          </p>
          <p>
            <label>Latitude <input name="lat" required inputMode="decimal" /></label>{' '}
            <label>Longitude <input name="lng" required inputMode="decimal" /></label>
          </p>
          <p>
            <label>Window start <input name="windowStart" type="time" required defaultValue="08:00" /></label>{' '}
            <label>Window end <input name="windowEnd" type="time" required defaultValue="12:00" /></label>{' '}
            <label>Duration (min) <input name="durationMin" type="number" min={1} max={720} required defaultValue={60} /></label>
          </p>
          <p>
            <label>Skill <select name="skill" defaultValue="repair">{SKILLS.map((s) => <option key={s}>{s}</option>)}</select></label>{' '}
            <label>Priority <select name="priority" defaultValue="standard">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
          </p>
          <button type="submit">Add job</button>
        </ActionForm>
      </details>

      <details>
        <summary>Add a technician</summary>
        <ActionForm action={bind(addTech)}>
          <input type="hidden" name="date" value={date} />
          <p><label>Name <input name="name" required maxLength={120} /></label></p>
          <fieldset>
            <legend>Skills</legend>
            {SKILLS.map((s) => <label key={s} style={{ marginRight: 12 }}><input type="checkbox" name="skills[]" value={s} /> {s}</label>)}
          </fieldset>
          <p>
            <label>Shift start <input name="shiftStart" type="time" required defaultValue="08:00" /></label>{' '}
            <label>Shift end <input name="shiftEnd" type="time" required defaultValue="17:00" /></label>{' '}
            <label>Lunch earliest <input name="lunchEarliest" type="time" required defaultValue="11:30" /></label>{' '}
            <label>Lunch latest <input name="lunchLatest" type="time" required defaultValue="13:00" /></label>
          </p>
          <p>
            <label>Home latitude <input name="homeLat" required inputMode="decimal" /></label>{' '}
            <label>Home longitude <input name="homeLng" required inputMode="decimal" /></label>{' '}
            <label>Max jobs <input name="maxJobs" type="number" min={0} max={50} required defaultValue={8} /></label>
          </p>
          <p>
            <label>Login{' '}
              <select name="userId" defaultValue="">
                <option value="">No login</option>
                {members.filter((m) => !linked.has(m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.user.email}</option>)}
              </select>
            </label>
          </p>
          <button type="submit">Add technician</button>
        </ActionForm>
      </details>
    </main>
  );
}
