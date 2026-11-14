import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { myDay } from '@/lib/dispatch/tech-day';
import { DATE_RE, hhmm, todayIn } from '@/lib/dispatch/time';

export const metadata = { title: 'My day' };

// A technician's own route for a day (TR-05). The mobile-width day view with statuses is Phase 3.
export default async function MyDay({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const date = typeof q.date === 'string' && DATE_RE.test(q.date) && !Number.isNaN(Date.parse(`${q.date}T00:00:00Z`)) ? q.date : todayIn();
  const { tech, stops, planId } = await myDay(ctx, date);
  return (
    <main style={{ maxWidth: 640 }}>
      <h1>My day · {date}</h1>
      <form method="get"><label>Day <input type="date" name="date" defaultValue={date} /></label> <button type="submit">Show</button></form>
      {!tech && <p>You are not set up as a technician in this org. Ask your dispatcher to link your login.</p>}
      {tech && !planId && <p>No plan has been saved for this day yet.</p>}
      {tech && planId && stops.length === 0 && <p>No stops for you on this day.</p>}
      {tech && stops.length > 0 && (
        <ol aria-label={`Stops for ${tech.name}`}>
          {stops.map((s) => (
            <li key={s.id}>
              <Link href={`/o/${ctx.slug}/dispatch/stops/${s.id}`}>{s.job.ref}</Link> · {hhmm(s.start)}–{hhmm(s.end)} · {s.job.customer}, {s.job.address}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
