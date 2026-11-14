import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import pg from 'pg';

// Truckroll Phase 2 gate (PRD §7): a dispatcher plans the demo day; a technician then sees only their own day (TR-05).
// Needs the solver service: CI starts it (`uvicorn app:app --port 7801` in solver/); locally run the same first.
const DAY = '2026-11-16';
const SOLVER = (process.env.SOLVER_URL || 'http://127.0.0.1:7801').replace(/\/+$/, '');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });

test.describe.configure({ mode: 'serial' });
test.afterAll(() => db.end());
test.beforeAll(async () => {
  const health = await fetch(`${SOLVER}/health`).catch(() => null);
  expect(health?.ok, `solver not running at ${SOLVER}: start it with "cd solver && .venv/bin/uvicorn app:app --port 7801"`).toBe(true);
  await db.query('DELETE FROM "RateLimit"'); // the server sees every local run as one IP
  // Seeded as child processes, like e2e/demo.spec.ts (F-08).
  execSync('npm run seed:demo:test');
  execSync('npm run seed:dispatch:test');
});

async function demoSignIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
}

test('dispatcher pins a job and plans the demo day', async ({ page }) => {
  await demoSignIn(page, 'admin@acme.demo.test');
  await page.goto(`/o/acme/dispatch?date=${DAY}`);
  await expect(page.getByRole('heading', { name: `Dispatch · ${DAY}` })).toBeVisible();
  const jobs = page.getByRole('table', { name: 'Jobs' });
  await expect(jobs.locator('tbody tr')).toHaveCount(24);
  await expect(page.getByRole('table', { name: 'Technicians' }).locator('tbody tr')).toHaveCount(6);
  await expect(page.getByText('No plan saved for this day yet.')).toBeVisible();

  // Pin J02 (a Tahlequah-side job) to Tahlequah One.
  await page.getByLabel('Pin J02 to').selectOption({ label: 'Tahlequah One' });
  await page.getByRole('button', { name: 'Pin J02' }).click();
  await expect(page.getByRole('row', { name: 'Job J02' })).toContainText('Pinned to Tahlequah One');

  await page.getByRole('button', { name: 'Plan the day' }).click();
  await expect(page.getByRole('status')).toContainText('Plan saved: 24 stops, 0 unassigned', { timeout: 30_000 });
  await expect(page.getByLabel('Plan summary')).toContainText('0 unassigned');
  await expect(page.getByRole('region', { name: /^Route for / })).toHaveCount(6);
  // The pin held: J02 is on Tahlequah One's route and the jobs table says so.
  await expect(page.getByRole('table', { name: 'Stops for Tahlequah One' })).toContainText('J02');
  await expect(page.getByRole('row', { name: 'Job J02' })).toContainText(/Tahlequah One #\d+/);
  for (const row of await jobs.locator('tbody tr').all()) await expect(row).toContainText('scheduled');
});

test('a technician sees only their own day; another tech’s stop is a 404', async ({ page }) => {
  await demoSignIn(page, 'member@acme.demo.test');
  await page.goto(`/o/acme/dispatch/my-day?date=${DAY}`);
  const mine = page.getByRole('list', { name: 'Stops for Muskogee One' });
  await expect(mine.getByRole('listitem').first()).toBeVisible();
  const own = await db.query(
    `SELECT s.id FROM "PlanStop" s JOIN "Technician" t ON t.id = s."techId" JOIN "Org" o ON o.id = s."orgId"
     WHERE o.slug = 'acme' AND s."planId" = (SELECT id FROM "DispatchPlan" p WHERE p."orgId" = o.id ORDER BY "createdAt" DESC LIMIT 1)
     ORDER BY (t.name = 'Muskogee One') DESC, s.seq`,
  );
  const ownCount = (await db.query(`SELECT count(*)::int AS n FROM "PlanStop" s JOIN "Technician" t ON t.id = s."techId" WHERE t.name = 'Muskogee One' AND s."planId" = (SELECT "planId" FROM "PlanStop" WHERE id = $1)`, [own.rows[0].id])).rows[0].n;
  await expect(mine.getByRole('listitem')).toHaveCount(ownCount);

  await mine.getByRole('link').first().click();
  await expect(page.getByText('Muskogee One, stop 1')).toBeVisible();

  const theirs = await db.query(
    `SELECT s.id FROM "PlanStop" s JOIN "Technician" t ON t.id = s."techId" WHERE t.name <> 'Muskogee One' AND s."planId" = (SELECT "planId" FROM "PlanStop" WHERE id = $1) LIMIT 1`,
    [own.rows[0].id],
  );
  const res = await page.goto(`/o/acme/dispatch/stops/${theirs.rows[0].id}`);
  expect(res!.status()).toBe(404);
  const missing = await page.goto('/o/acme/dispatch/stops/00000000-0000-4000-8000-000000000000');
  expect(missing!.status()).toBe(404);
});
