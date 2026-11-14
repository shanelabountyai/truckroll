-- Truckroll Phase 2 (prisma/schema/truckroll.prisma). Hand-written in Prisma's own shape (D-12: the sandbox could not run
-- the schema engine); CI's `prisma migrate diff --exit-code` step proves it matches the schema (D-24).

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('emergency', 'standard', 'maintenance');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('unscheduled', 'scheduled', 'en_route', 'on_site', 'done', 'cant_complete');

-- CreateTable
CREATE TABLE "Technician" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "skills" TEXT[],
    "shiftStart" INTEGER NOT NULL,
    "shiftEnd" INTEGER NOT NULL,
    "homeLat" DOUBLE PRECISION NOT NULL,
    "homeLng" DOUBLE PRECISION NOT NULL,
    "lunchEarliest" INTEGER NOT NULL,
    "lunchLatest" INTEGER NOT NULL,
    "maxJobs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Technician_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "date" DATE NOT NULL,
    "windowStart" INTEGER NOT NULL,
    "windowEnd" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "skill" TEXT NOT NULL,
    "priority" "JobPriority" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'unscheduled',
    "pinTechId" UUID,
    "pinPosition" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchPlan" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "createdById" UUID,
    "problem" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "driveMin" INTEGER NOT NULL,
    "lateMin" INTEGER NOT NULL,
    "unassignedCount" INTEGER NOT NULL,
    "stoppedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanStop" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "techId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "arrival" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "driveMin" INTEGER NOT NULL,
    "slackMin" INTEGER NOT NULL,
    "lateMin" INTEGER NOT NULL,

    CONSTRAINT "PlanStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Technician_orgId_idx" ON "Technician"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Technician_orgId_userId_key" ON "Technician"("orgId", "userId");

-- CreateIndex
CREATE INDEX "Job_orgId_date_idx" ON "Job"("orgId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Job_orgId_date_ref_key" ON "Job"("orgId", "date", "ref");

-- CreateIndex
CREATE INDEX "DispatchPlan_orgId_date_createdAt_idx" ON "DispatchPlan"("orgId", "date", "createdAt");

-- CreateIndex
CREATE INDEX "PlanStop_orgId_idx" ON "PlanStop"("orgId");

-- CreateIndex
CREATE INDEX "PlanStop_techId_planId_idx" ON "PlanStop"("techId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanStop_planId_jobId_key" ON "PlanStop"("planId", "jobId");

-- AddForeignKey
ALTER TABLE "Technician" ADD CONSTRAINT "Technician_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Technician" ADD CONSTRAINT "Technician_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_pinTechId_fkey" FOREIGN KEY ("pinTechId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchPlan" ADD CONSTRAINT "DispatchPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStop" ADD CONSTRAINT "PlanStop_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStop" ADD CONSTRAINT "PlanStop_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DispatchPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStop" ADD CONSTRAINT "PlanStop_techId_fkey" FOREIGN KEY ("techId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStop" ADD CONSTRAINT "PlanStop_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
