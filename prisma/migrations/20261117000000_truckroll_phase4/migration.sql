-- Truckroll Phase 4 (prisma/schema/truckroll.prisma): customer phone on Job, the EtaText table, and the TR-06 trigger.
-- Hand-written in Prisma's own shape (D-12); CI's `prisma migrate diff --exit-code` step proves the tables match (D-24).
-- The trigger is not part of the Prisma schema (like the AuditEvent append-only trigger) and diff does not see it.

-- CreateEnum
CREATE TYPE "EtaStatus" AS ENUM ('draft', 'sent', 'discarded');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "customerPhone" TEXT;

-- CreateTable
CREATE TABLE "EtaText" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "phone" TEXT,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fallbackReason" TEXT,
    "status" "EtaStatus" NOT NULL DEFAULT 'draft',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(6),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "capturedMessageId" UUID,

    CONSTRAINT "EtaText_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EtaText_orgId_planId_idx" ON "EtaText"("orgId", "planId");

-- CreateIndex
CREATE INDEX "EtaText_jobId_idx" ON "EtaText"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "EtaText_planId_jobId_key" ON "EtaText"("planId", "jobId");

-- AddForeignKey
ALTER TABLE "EtaText" ADD CONSTRAINT "EtaText_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtaText" ADD CONSTRAINT "EtaText_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DispatchPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtaText" ADD CONSTRAINT "EtaText_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- TR-06 (hand-written): an ETA text is "sent" only with a dispatcher approval event in the audit log for exactly this
-- text (same org, same draft, same plan, same approver, SHA-256 of the same body), and a sent text never changes.
-- SECURITY INVOKER: under RLS enforce the audit lookup sees only the caller's org (app.org_id), which is the row's org.
CREATE FUNCTION "truckroll_eta_text_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'sent' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."body" IS DISTINCT FROM OLD."body" OR NEW."phone" IS DISTINCT FROM OLD."phone"
      OR NEW."orgId" IS DISTINCT FROM OLD."orgId" OR NEW."planId" IS DISTINCT FROM OLD."planId" OR NEW."jobId" IS DISTINCT FROM OLD."jobId"
      OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW."capturedMessageId" IS DISTINCT FROM OLD."capturedMessageId" THEN
      RAISE EXCEPTION 'TR-06: a sent ETA text can never change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'sent' THEN
    IF NEW."approvedById" IS NULL OR NEW."approvedAt" IS NULL OR NEW."sentAt" IS NULL OR NEW."capturedMessageId" IS NULL OR NEW."phone" IS NULL THEN
      RAISE EXCEPTION 'TR-06: an ETA text is sent only with an approver, approval and send times, a phone and a captured message' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "AuditEvent" a
      WHERE a."orgId" = NEW."orgId" AND a."action" = 'dispatch.eta_approved' AND a."targetType" = 'etaText' AND a."targetId" = NEW."id"::text
        AND a."actorUserId" = NEW."approvedById" AND a."data"->>'planId' = NEW."planId"::text
        AND a."data"->>'bodySha256' = encode(sha256(convert_to(NEW."body", 'UTF8')), 'hex')
    ) THEN
      RAISE EXCEPTION 'TR-06: no dispatcher approval event in the audit log for this ETA text' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "EtaText_tr06_guard" BEFORE INSERT OR UPDATE ON "EtaText" FOR EACH ROW EXECUTE FUNCTION "truckroll_eta_text_guard"();
