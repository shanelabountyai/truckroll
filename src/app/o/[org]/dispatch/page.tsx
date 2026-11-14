import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { PRIORITIES, SKILLS, type Plan } from '@/lib/dispatch/contract';
import type { PlanMetrics } from '@/lib/dispatch/metrics';
import { currentPlan } from '@/lib/dispatch/plan-store';
import { isDispatcher } from '@/lib/dispatch/roles';
import { DATE_RE, dayOf, hhmm, todayIn } from '@/lib/dispatch/time';
import { addJob, addTech, pinJob, planDay, unpinJob } from './actions';
import { TechTimeline, type StopJob } from './timeline';

export const metadata = { title: 'Dispatch' };

const cell = { textAlign: 'left' as const, padding: '2px 10px 2px 0', verticalAlign: 'top' as const };

// The dispatcher board (PRD §7 Phase 2): the day's jobs with pins, the technicians, Plan the day, and the current plan
// as one timeline per technician.
export default async function DispatchBoard({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const asked = typeof q.date === 'string' ? q.date : '';
  const date = DATE_RE.test(asked) && !Number.isNaN(Date.parse(`${asked}T00:00:00Z`)) ? asked : todayIn();
  if (!isDispatcher(ctx.role)) redirect(`/o/${ctx.slug}/dispatch/my-day?date=${date}`);

  const { techs, jobs, saved, members } = await withOrg(ctx, async (tx) => {
    const [techs, jobs, saved, members] = await Promise.all([
      tx.technician.findMany({ where: inOrg(ctx), orderBy: [{ name: 'asc' }, { id: 'asc' }], include: { user: { select: { email: true } } } }),
      tx.job.findMany({ where: { ...inOrg(ctx), date: dayOf(date) }, orderBy: [{ ref: 'asc' }, { id: 'asc' }] }),
      currentPlan(tx, ctx.orgId, date),
      tx.membership.findMany({ where: { ...inOrg(ctx), role: 'member' }, include: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { techs, jobs, saved, members };
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

  return (
    <main style={{ maxWidth: 1200 }}>
      <h1>Dispatch · {date}</h1>
      <form method="get" style={{ marginBottom: '1rem' }}>
        <label>Day <input type="date" name="date" defaultValue={date} /></label> <button type="submit">Show</button>
      </form>
      {q.saved === '1' && saved && plan && <p role="status">Plan saved: {plan.routes.reduce((n, r) => n + r.stops.length, 0)} stops, {saved.unassignedCount} unassigned.</p>}

      <ActionForm action={bind(planDay)}>
        <input type="hidden" name="date" value={date} />
        <button type="submit" disabled={!jobs.length || !techs.length}>Plan the day</button>{' '}
        <small>Pinned jobs stay where they are pinned. Every plan is checked before it is saved.</small>
      </ActionForm>

      <h2>Plan</h2>
      {!plan && <p>No plan saved for this day yet.</p>}
      {plan && metrics && (
        <>
          <p aria-label="Plan summary">
            Saved {saved!.createdAt.toISOString().slice(11, 16)} UTC · on time {metrics.onTimePct}% · drive {metrics.driveMin} min · utilization {metrics.utilizationPct}% ·{' '}
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
              stopHref={() => null}
            />
          ))}
          {plan.unassigned.length > 0 && (
            <section aria-label="Unassigned jobs">
              <h3>Unassigned</h3>
              <ul>
                {plan.unassigned.map((u) => (
                  <li key={u.jobId}>
                    {jobInfo.get(u.jobId)?.ref ?? 'removed job'} — {u.reasons.join(', ')}
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
                <td style={cell}>{j.customer}<br /><small>{j.address}</small></td>
                <td style={cell}>{hhmm(j.windowStart)}–{hhmm(j.windowEnd)}</td>
                <td style={cell}>{j.durationMin} min</td>
                <td style={cell}>{j.skill}</td>
                <td style={cell}>{j.priority}</td>
                <td style={cell}>{j.status.replace('_', ' ')}</td>
                <td style={cell}>{a ? `${techName.get(a.techId)} #${a.seq}` : reasons.get(j.id)?.join(', ') ?? '—'}</td>
                <td style={cell}>
                  {j.pinTechId ? (
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
            <label>Address <input name="address" required maxLength={200} /></label>
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
