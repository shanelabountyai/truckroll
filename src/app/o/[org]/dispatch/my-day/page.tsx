import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ACTIVE, STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';
import { myDay } from '@/lib/dispatch/tech-day';
import { isRealDay, todayIn } from '@/lib/dispatch/time';
import { C, btn, input } from '@/app/ui/theme';
import { STATUS_LOOK, clock, dayName, minutes, plural, wall } from '../look';
import { StatusBadge, StatusButtons } from '../status-buttons';

export const metadata = { title: 'My day' };

// A technician's own day on a phone (PRD §7 Phase 3; TR-05: their stops only), drawn from docs/design/MyDay.dc.html.
// One list in route order (D-67): the current stop (en route / on site, else the next one not started) is the big
// card with the status buttons; every other stop is a row that opens its stop page.

export default async function MyDay({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const date = typeof q.date === 'string' && isRealDay(q.date) ? q.date : todayIn();
  const { tech, stops, planId } = await myDay(ctx, date);
  const status = (s: (typeof stops)[number]) => s.job.status as JobStatus;
  const now = stops.find((s) => ACTIVE.includes(status(s))) ?? stops.find((s) => status(s) === 'scheduled');
  const doneCount = stops.filter((s) => status(s) === 'done' || status(s) === 'cant_complete').length;
  const stopHref = (id: string) => `/o/${ctx.slug}/dispatch/stops/${id}`;
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 0, fontSize: 16 }}>
      <div className="tr-onDark" style={{ background: C.ink, color: '#FFFFFF', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderTop: '1px solid #2A3A48' }}>
        <h1 style={{ margin: 0, fontSize: 17 }}>{tech ? `${tech.name} · ` : 'My day · '}{dayName(date, true)}</h1>
        {tech && <span style={{ fontSize: 14, color: C.headLink }}>{plural(stops.length, 'stop')}</span>}
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
            Day <input type="date" name="date" defaultValue={date} style={{ ...input, fontSize: 16 }} />
          </label>
          <button type="submit" style={btn.secondary}>Show</button>
        </form>
        {!tech && <Notice>You are not set up as a technician in this org. Ask your dispatcher to link your login.</Notice>}
        {tech && !planId && <Notice>No plan has been saved for this day yet. Your stops show up here once the office plans the day.</Notice>}
        {tech && planId && stops.length === 0 && <Notice>No stops for you on this day.</Notice>}
        {tech && stops.length > 0 && (
          <>
            <p aria-label="Day summary" style={{ margin: 0, fontSize: 14, color: C.text2 }}>
              {tech.name} · {plural(stops.length, 'stop')} · {doneCount} finished{now && now !== stops[0] ? <> · <a href="#now">Jump to the current stop</a></> : null}
            </p>
            <ol aria-label={`Stops for ${tech.name}`} style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stops.map((s) => {
                const st = status(s);
                const emergency = s.job.priority === 'emergency';
                if (now?.id === s.id) {
                  const since = st === 'en_route' ? s.job.enRouteAt : st === 'on_site' ? s.job.onSiteAt : null;
                  return (
                    <li key={s.id} id="now" aria-current="step" style={{ background: C.card, border: `2px solid ${emergency ? C.red : C.blue}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 12 }}>
                      <span style={{ alignSelf: 'flex-start', background: emergency ? C.red : C.blue, color: '#FFFFFF', borderRadius: 999, padding: '2px 10px', fontSize: 13, fontWeight: 700 }}>
                        {emergency ? <><span aria-hidden="true">! </span>EMERGENCY · </> : null}{ACTIVE.includes(st) ? 'NOW' : 'NEXT STOP'} · STOP {s.seq}
                      </span>
                      <h2 style={{ margin: 0, fontSize: 22 }}>
                        <Link href={stopHref(s.id)} style={{ color: C.ink }}>Job {s.job.ref}</Link> <span style={{ fontWeight: 600, color: C.text2, fontSize: 18 }}>· {s.job.skill}</span>
                      </h2>
                      <div>
                        <div style={{ fontWeight: 600 }}>{s.job.customer}</div>
                        <div style={{ color: C.text2 }}>{s.job.address}</div>
                        {s.job.customerPhone && <a href={`tel:${s.job.customerPhone}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, fontWeight: 600 }}>Call {s.job.customerPhone}</a>}
                      </div>
                      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, fontSize: 14 }}>
                        <Fact label="Planned arrival" value={clock(s.arrival)} />
                        <Fact label="Customer window" value={`${clock(s.job.windowStart)}–${clock(s.job.windowEnd)}`} />
                        <Fact label="Drive" value={minutes(s.driveMin)} />
                        <Fact label="Slack" value={minutes(s.slackMin)} />
                      </dl>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <StatusBadge status={st} />
                        {s.job.statusNote && <span style={{ fontSize: 14 }}>Note: {s.job.statusNote}</span>}
                      </div>
                      <StatusButtons slug={ctx.slug} jobId={s.job.id} jobRef={s.job.ref} status={st} back="my-day" />
                      <span style={{ fontSize: 13, color: C.text3 }}>
                        {since ? <>Status: <strong>{STATUS_LABEL[st]}</strong> since {wall(since)}. </> : null}The office sees each tap right away.
                      </span>
                    </li>
                  );
                }
                const finished = st === 'done' || st === 'cant_complete';
                const look = STATUS_LOOK[st];
                const meta = st === 'done' && s.job.doneAt ? `Done ${wall(s.job.doneAt)}` : st === 'cant_complete' ? `Can’t complete${s.job.statusNote ? `: ${s.job.statusNote}` : ''}` : `Window ${clock(s.job.windowStart)}–${clock(s.job.windowEnd)} · drive ${s.driveMin} min${s.slackMin ? ` · slack ${s.slackMin} min` : ''}`;
                return (
                  <li key={s.id} style={{ background: C.card, border: `1px solid ${emergency && !finished ? C.red : C.cardEdge}`, borderRadius: 12 }}>
                    <Link href={stopHref(s.id)} className="tr-row" style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center', minHeight: 64, boxSizing: 'border-box' }}>
                      <span aria-hidden="true" style={{ flex: '0 0 auto', width: 30, height: 30, borderRadius: '50%', background: finished ? C.grey : C.card, border: `2px solid ${finished ? C.grey : C.blue}`, color: finished ? C.ink : C.blue, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, boxSizing: 'border-box' }}>
                        {finished ? look.glyph : s.seq}
                      </span>
                      <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span className="tr-rowTitle" style={{ fontWeight: 700, color: finished ? C.text2 : C.ink }}>
                          <span className="tr-sr">Stop {s.seq}, </span>{clock(s.start)} · Job {s.job.ref} · {s.job.skill}{emergency ? ' · emergency' : ''}
                        </span>
                        <span style={{ fontSize: 13, color: C.text2 }}>{meta}</span>
                      </span>
                      <span style={{ flex: '0 0 auto' }}><StatusBadge status={st} /></span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            <p style={{ margin: 0, fontSize: 13, color: C.text3 }}>You only see your own stops. Changes to your route come from the office and show here when you reload the page.</p>
          </>
        )}
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

function Notice({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, background: C.card, border: `1px solid ${C.cardEdge}`, borderRadius: 12, padding: '14px 16px' }}>{children}</p>;
}
