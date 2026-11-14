import { notFound } from 'next/navigation';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { currentPlan } from './plan-store';
import { isoDay } from './time';
import { isDispatcher } from './roles';

// TR-05: a technician (member) reads only their own day. Both reads below scope by org first, then by the technician
// row linked to the signed-in user; anything else is notFound, the same answer as an id that does not exist.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in member's technician row and their stops on the day's current plan. */
export async function myDay(ctx: OrgCtx, date: string) {
  return withOrg(ctx, async (tx) => {
    const tech = await tx.technician.findFirst({ where: { ...inOrg(ctx), userId: ctx.userId } });
    if (!tech) return { tech: null, stops: [], planId: null };
    const plan = await currentPlan(tx, ctx.orgId, date);
    const stops = plan
      ? await tx.planStop.findMany({ where: { ...inOrg(ctx), planId: plan.id, techId: tech.id }, include: { job: true }, orderBy: { seq: 'asc' } })
      : [];
    return { tech, stops, planId: plan?.id ?? null };
  }, { atomic: false });
}

/** One stop: a dispatcher may read any in the org; a technician only one of their own. */
export async function readStop(ctx: OrgCtx, id: string) {
  if (!UUID.test(id)) notFound();
  const stop = await withOrg(ctx, (tx) =>
    tx.planStop.findFirst({ where: { ...inOrg(ctx), id }, include: { job: true, tech: { select: { id: true, name: true, userId: true } }, plan: { select: { date: true, createdAt: true } } } }),
    { atomic: false },
  );
  if (!stop) notFound();
  if (!isDispatcher(ctx.role) && stop.tech.userId !== ctx.userId) notFound();
  // Phase 3: statuses are set on the day's current plan only.
  const current = await withOrg(ctx, (tx) => currentPlan(tx, ctx.orgId, isoDay(stop.plan.date)), { atomic: false });
  return { ...stop, current: current?.id === stop.planId };
}
