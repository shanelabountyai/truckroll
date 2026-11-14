import type { Route } from '@/lib/dispatch/contract';
import { hhmm } from '@/lib/dispatch/time';

// One technician's day as positioned blocks (PRD §7 Phase 2: "plan view per tech as a timeline"), with the same data
// in a table beneath for screen readers and tests. Server-rendered; no client JS.

export type StopJob = { ref: string; customer: string; priority: string; windowStart: number; windowEnd: number; status?: string };

const td = { paddingRight: 12 };
const COLORS: Record<string, string> = { emergency: '#c62828', standard: '#1565c0', maintenance: '#2e7d32' };

export function TechTimeline({
  name,
  shiftStart,
  shiftEnd,
  route,
  jobs,
  scale,
  stopHref,
}: {
  name: string;
  shiftStart: number;
  shiftEnd: number;
  route: Route | null;
  jobs: Map<string, StopJob>;
  scale: { from: number; to: number };
  stopHref: (jobId: string) => string | null;
}) {
  const span = Math.max(1, scale.to - scale.from);
  const pct = (m: number) => `${(((m - scale.from) / span) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `${((Math.max(0, b - a) / span) * 100).toFixed(3)}%`;
  const stops = route?.stops ?? [];
  return (
    <section aria-label={`Route for ${name}`} style={{ margin: '1rem 0' }}>
      <h3 style={{ margin: '0 0 .25rem' }}>
        {name} <small>· {stops.length} stop{stops.length === 1 ? '' : 's'}{route?.lunch ? ` · lunch ${hhmm(route.lunch.start)}` : ''}{route ? ` · home ${hhmm(route.returnAt)}` : ''}</small>
      </h3>
      <div aria-hidden="true" style={{ position: 'relative', height: 34, background: '#f4f4f4', border: '1px solid #ccc', borderRadius: 4 }}>
        <div style={{ position: 'absolute', left: pct(shiftStart), width: width(shiftStart, shiftEnd), top: 0, bottom: 0, background: '#e8eef7' }} />
        {route?.lunch && (
          <div title={`Lunch ${hhmm(route.lunch.start)}–${hhmm(route.lunch.end)}`} style={{ position: 'absolute', left: pct(route.lunch.start), width: width(route.lunch.start, route.lunch.end), top: 4, bottom: 4, background: '#ffd54f', borderRadius: 3 }} />
        )}
        {stops.map((s) => {
          const j = jobs.get(s.jobId);
          return (
            <div key={s.jobId} title={`${j?.ref ?? s.jobId} ${hhmm(s.start)}–${hhmm(s.end)}`} style={{ position: 'absolute', left: pct(s.start), width: width(s.start, s.end), top: 2, bottom: 2, background: COLORS[j?.priority ?? 'standard'], color: '#fff', fontSize: 11, overflow: 'hidden', whiteSpace: 'nowrap', borderRadius: 3, padding: '0 3px', boxSizing: 'border-box'}}>
              {j?.ref}
            </div>
          );
        })}
      </div>
      {stops.length > 0 && (
        <table style={{ fontSize: 13, borderCollapse: 'collapse', marginTop: 4 }}>
          <caption style={{ textAlign: 'left' }}>Stops for {name}</caption>
          <thead>
            <tr>
              {['#', 'Job', 'Customer', 'Window', 'Arrive', 'Work', 'Drive', 'Status'].map((h) => (
                <th key={h} style={{ textAlign: 'left', paddingRight: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stops.map((s) => {
              const j = jobs.get(s.jobId);
              const href = stopHref(s.jobId);
              return (
                <tr key={s.jobId}>
                  <td style={td}>{s.seq}</td>
                  <td style={td}>{href ? <a href={href}>{j?.ref}</a> : j?.ref}</td>
                  <td style={td}>{j?.customer}</td>
                  <td style={td}>{j ? `${hhmm(j.windowStart)}–${hhmm(j.windowEnd)}` : ''}</td>
                  <td style={td}>{hhmm(s.arrival)}</td>
                  <td style={td}>{hhmm(s.start)}–{hhmm(s.end)}</td>
                  <td style={td}>{s.driveMin} min</td>
                  <td style={td}>{j?.status?.replace('_', ' ') ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
