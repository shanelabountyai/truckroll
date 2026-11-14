-- Truckroll Phase 3 (prisma/schema/truckroll.prisma): technician status times on Job, re-plan fields on DispatchPlan.
-- Hand-written in Prisma's own shape (D-12); CI's `prisma migrate diff --exit-code` step proves it matches (D-24).
-- No new tables, so no new RLS policies; both tables are already in the export (INV-34).

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "doneAt" TIMESTAMPTZ(6),
ADD COLUMN     "enRouteAt" TIMESTAMPTZ(6),
ADD COLUMN     "onSiteAt" TIMESTAMPTZ(6),
ADD COLUMN     "statusNote" TEXT;

-- AlterTable
ALTER TABLE "DispatchPlan" ADD COLUMN     "asOf" INTEGER,
ADD COLUMN     "basePlanId" UUID;
