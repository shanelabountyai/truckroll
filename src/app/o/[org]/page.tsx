import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { isDispatcher } from '@/lib/dispatch/roles';

// Truckroll home: a link to the board (dispatchers) or to My day (technicians). A new org keeps the template's empty
// state heading, which the onboarding e2e checks.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  const techs = await withOrg(ctx, (tx) => tx.technician.count({ where: inOrg(ctx) }), { atomic: false });
  if (!isDispatcher(ctx.role))
    return (
      <main>
        <h1>Truckroll</h1>
        <p><Link href={`${base}/dispatch/my-day`}>Open my day</Link></p>
      </main>
    );
  return (
    <main>
      <h1>{techs ? 'Truckroll' : 'Nothing here yet'}</h1>
      <p>
        <Link href={`${base}/dispatch`}>Open the dispatch board</Link>
        {!techs && <> to add your technicians and the day&apos;s jobs, or <Link href={`${base}/settings/members`}>invite your team</Link>.</>}
      </p>
    </main>
  );
}
