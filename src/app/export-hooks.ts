import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  // Truckroll (Phase 2): the org's own dispatch data, whole rows (no secrets in these tables).
  { name: 'Technician', rows: (tx, orgId) => tx.technician.findMany({ where: { orgId }, orderBy: { id: 'asc' } }) },
  { name: 'Job', rows: (tx, orgId) => tx.job.findMany({ where: { orgId }, orderBy: { id: 'asc' } }) },
  { name: 'DispatchPlan', rows: (tx, orgId) => tx.dispatchPlan.findMany({ where: { orgId }, orderBy: { id: 'asc' } }) },
  { name: 'PlanStop', rows: (tx, orgId) => tx.planStop.findMany({ where: { orgId }, orderBy: { id: 'asc' } }) },
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {};
