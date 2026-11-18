import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { isDispatcher } from '@/lib/dispatch/roles';
import { C, card } from '@/app/ui/theme';

// Truckroll home (gap design docs/design/OrgHome.dc.html, D-63): the board and metrics (dispatchers) or My day
// (technicians). A new org keeps the template's empty state heading, which the onboarding e2e checks (D-30).
const tile = { ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 4, textDecoration: 'none', color: C.ink, minHeight: 44 } as const;

export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  const techs = await withOrg(ctx, (tx) => tx.technician.count({ where: inOrg(ctx) }), { atomic: false });
  const cards = isDispatcher(ctx.role)
    ? [
        { href: `${base}/dispatch`, title: 'Open the dispatch board', what: techs ? 'Today’s jobs, pins, the plan and customer ETA texts' : 'Add your technicians and the day’s jobs, then plan the day' },
        ...(techs ? [{ href: `${base}/dispatch/metrics`, title: 'Metrics', what: 'On time, drive minutes, utilization, plan vs actual' }] : [{ href: `${base}/settings/members`, title: 'Invite your team', what: 'Dispatchers and technicians sign in with their own email' }]),
      ]
    : [{ href: `${base}/dispatch/my-day`, title: 'Open my day', what: 'Your stops for today, in order, with the status buttons' }];
  return (
    <main style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{!isDispatcher(ctx.role) || techs ? 'Truckroll' : 'Nothing here yet'}</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {cards.map((c) => (
          <Link key={c.href} href={c.href} style={tile}>
            <span style={{ fontWeight: 700, fontSize: 17, color: C.blue }}>{c.title} <span aria-hidden="true">→</span></span>
            <span style={{ fontSize: 14, color: C.text2 }}>{c.what}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
