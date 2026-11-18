import type { Route } from '@/lib/dispatch/contract';
import type { JobStatus } from '@/lib/dispatch/replan';
import { hhmm } from '@/lib/dispatch/time';
import { C } from '@/app/ui/theme';
import { Scroll } from '@/app/ui/scroll';
import { PRIORITY_LOOK, StatusBadge, clock, wall } from './look';

// The day as one grid, a row per technician (docs/design/Main.dc.html; PRD §7 Phase 2 "plan view per tech as a
// timeline"): hour ruler, drive time as grey stripes, lunch, each stop a block that opens its stop page, and the "now"
// line when the board shows today. The same data is in the stops tables (StopsTables) for screen readers and tests.
// Server-rendered; no client JS.

export type StopJob = {
  ref: string;
  customer: string;
  priority: string;
  skill: string;
  windowStart: number;
  windowEnd: number;
  status?: string;
  pinTechId?: string | null;
  enRouteAt?: Date | null;
  doneAt?: Date | null;
};
export type TimelineTech = { id: string; name: string; skills: string[]; shiftStart: number; shiftEnd: number };

const BLOCK: Record<string, { bg: string; fg: string; border: string }> = {
  emergency: { bg: C.red, fg: '#FFFFFF', border: `2px solid ${C.redDark}` },
  standard: { bg: C.blue, fg: '#FFFFFF', border: `1px solid ${C.blueDark}` },
  maintenance: { bg: C.grey, fg: C.ink, border: `1px solid ${C.greyEdge}` },
  finished: { bg: '#FFFFFF', fg: C.text2, border: `1px dashed ${C.greyEdge}` },
};

/** What a block says under its title, from the stop and the job's status. */
function blockMeta(status: string | undefined, pinned: boolean, s: Route['stops'][number], j: StopJob | undefined): { mark: string; meta: string } {
  if (status === 'done') return { mark: '✓', meta: j?.doneAt ? `Done ${wall(j.doneAt)}` : 'Done' };
  if (status === 'cant_complete') return { mark: '✕', meta: 'Can’t complete' };
  if (status === 'on_site') return { mark: '●', meta: 'On site · locked' };
  if (status === 'en_route') return { mark: '→', meta: `En route · arr ${clock(s.arrival)}` };
  const slack = s.slackMin ? ` · slack ${s.slackMin}m` : '';
  return { mark: pinned ? 'PIN' : '', meta: `${pinned ? 'Pinned · ' : ''}Arr ${clock(s.arrival)}${slack}` };
}

export function DayTimeline({
  techs,
  routes,
  jobs,
  scale,
  now,
  stopHref,
}: {
  techs: TimelineTech[];
  routes: Route[];
  jobs: Map<string, StopJob>;
  scale: { from: number; to: number };
  now: number | null;
  stopHref: (jobId: string) => string | null;
}) {
  const from = Math.floor(scale.from / 60) * 60;
  const to = Math.ceil(scale.to / 60) * 60;
  const span = Math.max(60, to - from);
  const pct = (m: number) => `${(((Math.min(Math.max(m, from), to) - from) / span) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `${((Math.max(0, Math.min(b, to) - Math.max(a, from)) / span) * 100).toFixed(3)}%`;
  const hours: number[] = [];
  for (let h = from; h <= to; h += 60) hours.push(h);
  const hourLine = `repeating-linear-gradient(90deg, ${C.ruleSoft} 0 1px, transparent 1px calc(100% / ${span / 60}))`;
  const showNow = now !== null && now >= from && now <= to;
  return (
    <Scroll label="Timeline (scrolls sideways)">
      <div style={{ minWidth: 760, padding: '8px 16px 16px' }}>
        <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: '140px 1fr' }}>
          <span />
          <div style={{ position: 'relative', height: 22, fontSize: 12, color: C.text3 }}>
            {hours.map((h) => (
              <span key={h} style={{ position: 'absolute', left: pct(h), transform: h === from ? 'none' : h === to ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                {((Math.floor(h / 60) + 11) % 12) + 1}{h < 720 ? 'a' : 'p'}
              </span>
            ))}
          </div>
        </div>
        {techs.map((t) => {
          const route = routes.find((r) => r.techId === t.id) ?? null;
          const stops = route?.stops ?? [];
          return (
            <section key={t.id} aria-label={`Route for ${t.name}`} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', borderTop: `1px solid ${C.ruleSoft}` }}>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '10px 8px 10px 0', minWidth: 0 }}>
                <span style={{ fontWeight: 700 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: C.text3 }}>
                  {stops.length} stop{stops.length === 1 ? '' : 's'}{route?.lunch ? ` · lunch ${clock(route.lunch.start)}` : ''}
                </span>
                <span style={{ fontSize: 12, color: C.text3 }}>{t.skills.join(' · ')}</span>
              </div>
              <div style={{ position: 'relative', height: 64, background: hourLine }}>
                {/* Off shift: the hours outside this tech's shift, shaded. */}
                <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: width(from, t.shiftStart), background: C.page }} />
                <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: pct(t.shiftEnd), right: 0, background: C.page }} />
                {stops.map((s) =>
                  s.driveMin > 0 ? (
                    <div key={`d-${s.jobId}`} aria-hidden="true" title={`Drive ${s.driveMin} min`} style={{ position: 'absolute', top: 26, height: 12, left: pct(s.arrival - s.driveMin), width: width(s.arrival - s.driveMin, s.arrival), background: `repeating-linear-gradient(135deg, ${C.greyEdge} 0 3px, transparent 3px 6px)`, borderRadius: 3 }} />
                  ) : null,
                )}
                {route && route.returnDriveMin > 0 && (
                  <div aria-hidden="true" title={`Drive home ${route.returnDriveMin} min`} style={{ position: 'absolute', top: 26, height: 12, left: pct(route.returnAt - route.returnDriveMin), width: width(route.returnAt - route.returnDriveMin, route.returnAt), background: `repeating-linear-gradient(135deg, ${C.greyEdge} 0 3px, transparent 3px 6px)`, borderRadius: 3 }} />
                )}
                {route?.lunch && (
                  <div aria-hidden="true" title={`Lunch ${hhmm(route.lunch.start)}–${hhmm(route.lunch.end)}`} style={{ position: 'absolute', top: 18, height: 28, left: pct(route.lunch.start), width: width(route.lunch.start, route.lunch.end), background: '#FFFFFF', border: `1px solid ${C.amberMid}`, color: C.amberText, borderRadius: 5, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', boxSizing: 'border-box' }}>
                    L
                  </div>
                )}
                {stops.map((s) => {
                  const j = jobs.get(s.jobId);
                  const finished = j?.status === 'done' || j?.status === 'cant_complete';
                  const look = BLOCK[finished ? 'finished' : (j?.priority ?? 'standard')] ?? BLOCK.standard!;
                  const pinned = !!j?.pinTechId;
                  const { mark, meta } = blockMeta(j?.status, pinned, s, j);
                  const href = stopHref(s.jobId);
                  const label = `Stop ${s.seq}, job ${j?.ref ?? ''} · ${j?.skill ?? ''}, ${j?.priority ?? ''}, ${clock(s.start)} to ${clock(s.end)}, ${meta}`;
                  const style = { position: 'absolute', top: 8, height: 48, left: pct(s.start), width: width(s.start, s.end), minWidth: 6, boxSizing: 'border-box', borderRadius: 7, background: look.bg, color: look.fg, border: look.border, padding: '4px 6px', overflow: 'hidden', display: 'flex', flexDirection: 'column', fontSize: 12, lineHeight: 1.25, zIndex: 1 } as const;
                  const body = (
                    <>
                      {/* The accessible name is the visible text plus screen-reader-only context (label-in-name, WCAG 2.5.3). */}
                      <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span className="tr-sr">Stop {s.seq}, job </span>{mark ? <span aria-hidden="true">{mark} </span> : null}{j?.ref} · {j?.skill}<span className="tr-sr">, {j?.priority}, {clock(s.start)} to {clock(s.end)}, </span>
                      </span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</span>
                    </>
                  );
                  return href ? (
                    <a key={s.jobId} href={href} className="tr-block" title={label} style={style}>{body}</a>
                  ) : (
                    <div key={s.jobId} title={label} style={style}>{body}</div>
                  );
                })}
                {showNow && <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: pct(now!), width: 2, background: C.red, zIndex: 2 }} />}
              </div>
            </section>
          );
        })}
        <p style={{ margin: '10px 0 0', fontSize: 12, color: C.text3 }}>
          {showNow ? `Red line: now, ${clock(now!)}. ` : ''}Striped bars are drive time; L is lunch. Every arrival is inside the customer’s window. Select a block to open the stop.
        </p>
      </div>
    </Scroll>
  );
}

export function Legend() {
  const sw = (bg: string, border: string) => <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: bg, border, verticalAlign: '-1px', marginRight: 4, boxSizing: 'border-box' }} />;
  return (
    <ul aria-label="Legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 13, color: C.text2, listStyle: 'none', margin: 0, padding: 0 }}>
      <li>{sw(C.red, `2px solid ${C.redDark}`)}<span aria-hidden="true">{PRIORITY_LOOK.emergency!.glyph} </span>Emergency</li>
      <li>{sw(C.blue, `1px solid ${C.blueDark}`)}Standard</li>
      <li>{sw(C.grey, `1px solid ${C.greyEdge}`)}Maintenance</li>
      <li><strong>PIN</strong> Pinned (never moved)</li>
      <li><span aria-hidden="true">✓ ● →</span> Done / on site / en route (locked)</li>
    </ul>
  );
}

/** Each technician's stops as a table (the timeline's text alternative; e2e reads these). */
export function StopsTable({ name, route, jobs, stopHref }: { name: string; route: Route | null; jobs: Map<string, StopJob>; stopHref: (jobId: string) => string | null }) {
  const stops = route?.stops ?? [];
  if (!stops.length) return null;
  const cell = { textAlign: 'left', padding: '7px 12px 7px 0', borderTop: `1px solid ${C.ruleSoft}`, verticalAlign: 'top' } as const;
  const head = { textAlign: 'left', padding: '6px 12px 6px 0', fontSize: 12, color: C.text2, whiteSpace: 'nowrap' } as const;
  return (
    <Scroll label={`Stops table for ${name} (scrolls sideways)`}>
      <table style={{ fontSize: 13, minWidth: 640, width: '100%' }}>
        <caption>Stops for {name}<span style={{ fontWeight: 400, color: C.text3 }}>{route?.lunch ? ` · lunch ${hhmm(route.lunch.start)}` : ''}{route ? ` · home ${hhmm(route.returnAt)}` : ''}</span></caption>
        <thead>
          <tr>{['#', 'Job', 'Customer', 'Window', 'Arrive', 'Work', 'Drive', 'Status'].map((h) => <th key={h} scope="col" style={head}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {stops.map((s) => {
            const j = jobs.get(s.jobId);
            const href = stopHref(s.jobId);
            return (
              <tr key={s.jobId}>
                <td style={cell}>{s.seq}</td>
                <td style={cell}>{href ? <a href={href}>{j?.ref}</a> : j?.ref}</td>
                <td style={cell}>{j?.customer}</td>
                <td style={cell}>{j ? `${hhmm(j.windowStart)}–${hhmm(j.windowEnd)}` : ''}</td>
                <td style={cell}>{hhmm(s.arrival)}</td>
                <td style={cell}>{hhmm(s.start)}–{hhmm(s.end)}</td>
                <td style={cell}>{s.driveMin} min</td>
                <td style={cell}>{j?.status ? <StatusBadge status={j.status as JobStatus} /> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );
}
