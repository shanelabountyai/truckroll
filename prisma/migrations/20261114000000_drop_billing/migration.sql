-- D-14 (revised in Phase 2): the billing module was removed in Phase 0 (D-08); its tables go too, so the migration
-- history matches the schema (CI's `prisma migrate diff --exit-code`, D-24). Dated after the template's newest
-- migration: the RLS policy migrations up to 20261108000002 ALTER "BillingAccount" unguarded (README).

-- DropTable
DROP TABLE "BillingAccount";

-- DropTable
DROP TABLE "StripeEvent";
