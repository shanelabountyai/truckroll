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

// ---------- Truckroll Phase 3 gate (PRD §7): the emergency at 10:40 lands with pins intact; TR-03 ----------

const AS_OF = 10 * 60 + 40;
type StopRow = { id: string; job: string; tech: string; seq: number; arrival: number; start: number; end: number };

/** The current plan's stops for Acme on the demo day, by job number. */
async function currentStops(): Promise<Map<string, StopRow>> {
  const { rows } = await db.query<StopRow>(
    `SELECT s.id, j.ref AS job, t.name AS tech, s.seq, s.arrival, s.start, s."end" FROM "PlanStop" s
       JOIN "Job" j ON j.id = s."jobId" JOIN "Technician" t ON t.id = s."techId"
      WHERE s."planId" = (SELECT p.id FROM "DispatchPlan" p JOIN "Org" o ON o.id = p."orgId" WHERE o.slug = 'acme' AND p.date = $1 ORDER BY p."createdAt" DESC, p.id DESC LIMIT 1)`,
    [DAY],
  );
  return new Map(rows.map((r) => [r.job, r]));
}

test('a technician works their day at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demoSignIn(page, 'member@acme.demo.test');
  await page.goto(`/o/acme/dispatch/my-day?date=${DAY}`);
  const mine = page.getByRole('list', { name: 'Stops for Muskogee One' });
  await expect(mine.getByRole('listitem').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Stops of Muskogee One that started by 10:40 on the plan: on site where 10:40 falls inside the stop, done before.
  const stops = [...(await currentStops()).values()].filter((s) => s.tech === 'Muskogee One').sort((a, b) => a.seq - b.seq);
  const started = stops.filter((s) => s.start <= AS_OF);
  expect(started.length).toBeGreaterThan(0);
  for (const s of started) {
    const card = mine.getByRole('listitem').filter({ hasText: s.job });
    await card.getByRole('button', { name: `On site: job ${s.job}` }).click();
    await expect(card).toContainText('on site');
    if (s.end <= AS_OF) {
      await card.getByRole('button', { name: `Done: job ${s.job}` }).click();
      await expect(card).toContainText('done');
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the emergency at 10:40 lands with pins and started work intact (TR-03)', async ({ page }) => {
  await demoSignIn(page, 'admin@acme.demo.test');
  const base = await currentStops();

  // The dispatcher records the rest of the work started by 10:40 from the stop pages (other techs have no login here).
  for (const s of [...base.values()].sort((a, b) => a.tech.localeCompare(b.tech) || a.seq - b.seq)) {
    if (s.tech === 'Muskogee One' || s.start > AS_OF) continue;
    await page.goto(`/o/acme/dispatch/stops/${s.id}`);
    await page.getByRole('button', { name: `On site: job ${s.job}` }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`Job ${s.job}`) })).toContainText('on site');
    if (s.end <= AS_OF) {
      await page.getByRole('button', { name: `Done: job ${s.job}` }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`Job ${s.job}`) })).toContainText('done');
    }
  }
  const startedJobs = [...base.values()].filter((s) => s.start <= AS_OF).map((s) => s.job);

  // A position pin on work that hasn't started: Tahlequah One's last stop stays its stop #N.
  const q1 = [...base.values()].filter((s) => s.tech === 'Tahlequah One').sort((a, b) => a.seq - b.seq);
  const pinned = q1[q1.length - 1]!;
  expect(pinned.start).toBeGreaterThan(AS_OF);
  await page.goto(`/o/acme/dispatch?date=${DAY}`);
  await page.getByLabel(`Pin ${pinned.job} to`).selectOption({ label: 'Tahlequah One' });
  await page.getByLabel(`Position for ${pinned.job}`).fill(String(pinned.seq));
  await page.getByRole('button', { name: `Pin ${pinned.job}`, exact: true }).click();
  await expect(page.getByRole('row', { name: `Job ${pinned.job}` })).toContainText(`Pinned to Tahlequah One at #${pinned.seq}`);
  // Work has started, so the board offers a re-plan instead of Plan the day.
  await expect(page.getByRole('button', { name: 'Plan the day' })).toHaveCount(0);

  // 10:40: a no-heat call. Emergency insert = add the job and re-plan from 10:40.
  await page.locator('summary', { hasText: 'Emergency insert' }).click();
  await page.getByLabel('Emergency re-plan time').fill('10:40');
  await page.getByLabel('Emergency window end').fill('12:40');
  await page.getByLabel('Emergency job number').fill('E1040');
  await page.getByLabel('Emergency customer').fill('Customer E-1040');
  await page.getByLabel('Emergency address').fill('1040 Example Rd, Synthetic OK');
  await page.getByLabel('Emergency latitude').fill('35.765');
  await page.getByLabel('Emergency longitude').fill('-95.345');
  await page.getByRole('button', { name: 'Add emergency and re-plan' }).click();
  await expect(page.getByRole('status')).toContainText('Re-plan saved as of 10:40', { timeout: 30_000 });
  await expect(page.getByLabel('Plan summary')).toContainText('Re-plan as of 10:40');
  await expect(page.getByLabel('Unplaced emergencies')).toHaveCount(0);

  // The emergency is on a route.
  const after = await currentStops();
  const e = after.get('E1040');
  expect(e, 'E1040 is routed').toBeDefined();
  await expect(page.getByRole('row', { name: 'Job E1040' })).toContainText(`${e!.tech} #${e!.seq}`);
  await expect(page.getByRole('table', { name: `Stops for ${e!.tech}` })).toContainText('E1040');
  // Pins intact: J02 (pinned in Phase 2's test) and the position pin.
  expect(after.get('J02')!.tech).toBe('Tahlequah One');
  expect([after.get(pinned.job)!.tech, after.get(pinned.job)!.seq]).toEqual(['Tahlequah One', pinned.seq]);
  await expect(page.getByRole('row', { name: `Job ${pinned.job}` })).toContainText(`Tahlequah One #${pinned.seq}`);
  // Started work intact (TR-03): same tech, same times, ahead of new work, status unchanged.
  for (const job of startedJobs) {
    const [b, a] = [base.get(job)!, after.get(job)!];
    expect({ job, tech: a.tech, arrival: a.arrival, start: a.start, end: a.end }).toEqual({ job, tech: b.tech, arrival: b.arrival, start: b.start, end: b.end });
    await expect(page.getByRole('row', { name: `Job ${job}` })).toContainText(/on site|done/);
  }
  for (const s of after.values()) {
    if (startedJobs.includes(s.job)) continue;
    const startedOnTech = startedJobs.filter((j) => after.get(j)!.tech === s.tech).length;
    expect(s.seq, `${s.job} comes after ${s.tech}'s started work`).toBeGreaterThan(startedOnTech);
  }

});

test('the technician’s phone shows the re-planned day', async ({ page }) => {
  const after = await currentStops();
  await page.setViewportSize({ width: 390, height: 844 });
  await demoSignIn(page, 'member@acme.demo.test');
  await page.goto(`/o/acme/dispatch/my-day?date=${DAY}`);
  const mine = page.getByRole('list', { name: 'Stops for Muskogee One' });
  await expect(mine.getByRole('listitem')).toHaveCount([...after.values()].filter((s) => s.tech === 'Muskogee One').length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
