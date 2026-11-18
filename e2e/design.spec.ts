import { execSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Design pass (docs/design/, PRD §8 "Design, UX and accessibility requirements"): every built screen passes axe at
// WCAG 2.1 AA in the light theme and under a dark OS setting (the app is light only, D-66), works at 390 px without a
// sideways page scroll, keeps 44 px targets, and is usable by keyboard (skip link, timeline blocks open their stop).
// Runs on the demo seed's rolling days: today (planned here, through the solver) and yesterday (finished).
// Needs the solver service, like e2e/dispatch.spec.ts.

const chicago = (offsetDays: number) =>
  new Date(Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
const TODAY = chicago(0);
const YESTERDAY = chicago(-1);
const FIXED = '2026-11-16'; // seed-dispatch's fixed e2e day wins a collision with a rolling day (D-58)

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  execSync('npm run seed:demo:test');
  execSync('npm run seed:dispatch:test');
});

async function demoSignIn(page: Page, email: string) {
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
}

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(found, `axe on ${where}`).toEqual([]);
}

const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);

/** Every visible button and form control inside the page content is at least 44 px tall (WCAG 2.5.5, PRD DR-05). */
async function targets(page: Page) {
  const small = await page.locator('#content').evaluate((root) =>
    [...root.querySelectorAll('button, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), summary')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ el: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`, h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44),
  );
  expect(small).toEqual([]);
}

test('the dispatcher board, planned today: axe, keyboard, targets, timeline blocks open stops', async ({ page }) => {
  test.skip(TODAY === FIXED, 'today is the fixed e2e day');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await demoSignIn(page, 'admin@acme.demo.test');
  await page.goto(`/o/acme/dispatch?date=${TODAY}`);
  await axe(page, 'board, no plan');
  await page.getByRole('button', { name: 'Plan the day' }).click();
  await expect(page.getByRole('status')).toContainText('Plan saved', { timeout: 30_000 });
  await axe(page, 'board, planned');
  await targets(page);

  // The header marks where you are; the skip link is the first tab stop and lands in the content.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dispatch', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto(`/o/acme/dispatch?date=${TODAY}`);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#content$/);

  // Every status reads as a word with a glyph (colour is never alone).
  const badge = page.getByRole('row', { name: /^Job J01/ }).getByText('scheduled');
  await expect(badge).toBeVisible();
  await expect(page.getByRole('row', { name: /^Job J01/ })).toContainText('○');

  // A timeline block is a link with a full description; Enter on it opens that stop.
  const route = page.getByRole('region', { name: /^Route for / }).first();
  const block = route.getByRole('link').first();
  await expect(block).toHaveAccessibleName(/^Stop 1, job J\d+ · [\w-]+ ?, \w+, \d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M, /);
  const job = /job (J\d+)/.exec((await block.textContent())!)![1]!;
  await block.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: new RegExp(`Job ${job}`) })).toBeVisible();

  // Review findings A-1/UX-M5: an emergency block carries a visible "!", and blocks say when work starts, not "Arr".
  await page.goto(`/o/acme/dispatch?date=${TODAY}`);
  const emergencyRef = (await page.getByRole('row', { name: /^Job J/ }).filter({ hasText: 'emergency' }).first().getAttribute('aria-label'))!.replace('Job ', '');
  const emergencyBlock = page.getByRole('region', { name: /^Route for / }).getByRole('link', { name: new RegExp(`job ${emergencyRef} `) });
  await expect(emergencyBlock).toContainText('!');
  await expect(emergencyBlock).toContainText('Starts ');

  // Every disclosure open (Emergency insert, Add a job, Add a technician) still passes axe.
  for (const name of ['Emergency insert', 'Add a job', 'Add a technician']) await page.locator('summary', { hasText: name }).click();
  await axe(page, 'board, every disclosure open');

  // UX-M3: a job added after the plan was saved is not silently missing — Not placed lists it, an emergency raises the banner.
  const add = page.locator('details', { has: page.locator('summary', { hasText: 'Add a job' }) });
  await add.getByLabel('Job number').fill('LATE1');
  await add.getByLabel('Customer').fill('Customer Late');
  await add.getByLabel('Address').fill('1 Example Rd, Synthetic OK');
  await add.getByLabel('Latitude').fill('35.76');
  await add.getByLabel('Longitude').fill('-95.36');
  await add.getByLabel('Window start').fill('13:00');
  await add.getByLabel('Window end').fill('17:00');
  await add.getByLabel('Priority').selectOption('emergency');
  await add.getByRole('button', { name: 'Add job' }).click();
  await expect(page.getByRole('list', { name: 'Jobs added after this plan' })).toContainText('Job LATE1');
  await expect(page.getByLabel('Unplaced emergencies')).toContainText('Job LATE1');
  await expect(page.getByLabel('Unplaced emergencies')).toContainText('added after this plan was saved');
  await axe(page, 'board, emergency added after the plan');

  // Under a dark OS setting the app stays on its light theme (D-66) and still passes.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/o/acme/dispatch?date=${TODAY}`);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(243, 245, 247)');
  await axe(page, 'board, dark OS setting');
});

test('the board, metrics and home at 390 px: no sideways page scroll, axe clean', async ({ page }) => {
  test.skip(YESTERDAY === FIXED, 'yesterday is the fixed e2e day');
  await page.setViewportSize({ width: 390, height: 844 });
  await demoSignIn(page, 'admin@acme.demo.test');
  for (const path of [`/o/acme/dispatch?date=${TODAY}`, `/o/acme/dispatch?date=${YESTERDAY}`, `/o/acme/dispatch/metrics?date=${YESTERDAY}`, '/o/acme']) {
    await page.goto(path);
    await noSidewaysScroll(page);
    await axe(page, `${path} at 390 px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/o/acme/dispatch/metrics?date=${YESTERDAY}`);
  await expect(page.getByLabel('Emergencies placed')).toContainText(/\d+ of \d+/);
  await axe(page, 'metrics, finished day');
});

test('the technician’s day and stop page at 390 px: the current stop is the big card; axe clean', async ({ page }) => {
  test.skip(TODAY === FIXED, 'today is the fixed e2e day');
  await page.setViewportSize({ width: 390, height: 844 });
  await demoSignIn(page, 'member@acme.demo.test');
  await page.goto(`/o/acme/dispatch/my-day?date=${TODAY}`);
  const list = page.getByRole('list', { name: 'Stops for Muskogee One' });
  const current = list.locator('li[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('NEXT STOP');
  await expect(current.getByRole('button', { name: /^En route: job / })).toBeVisible();
  await noSidewaysScroll(page);
  await targets(page);
  await axe(page, 'my day');
  await page.emulateMedia({ colorScheme: 'dark' });
  await axe(page, 'my day, dark OS setting');
  await page.emulateMedia({ colorScheme: 'light' });

  // A-2: with Can't complete open, the note field and button are named by their visible text.
  await current.getByRole('button', { name: /^En route: job / }).click();
  await expect(current).toContainText('en route');
  await current.locator('summary', { hasText: 'Can’t complete' }).click();
  await expect(current.getByRole('button', { name: /^Mark can’t complete: job / })).toBeVisible();
  await expect(current.getByLabel(/^Why\? \(the office reads this\)/)).toBeVisible();
  await axe(page, 'my day, Can’t complete open');

  // Another stop is a row that opens its stop page, which has the buttons when the stop is on the current plan.
  const others = list.locator('li:not([aria-current])');
  if (await others.count()) {
    await others.first().getByRole('link').click();
    await expect(page.getByRole('heading', { name: /^Job J\d+/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to my day' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^On site: job / })).toBeVisible();
    await noSidewaysScroll(page);
    await targets(page);
    await axe(page, 'stop page');
  }
});

test('the demo sign-in and a template settings page pick up the shared look and pass axe', async ({ page }) => {
  await page.goto('/demo');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(243, 245, 247)');
  await axe(page, '/demo');
  await demoSignIn(page, 'owner@acme.demo.test');
  await page.goto('/o/acme/settings/members');
  await axe(page, 'members settings');
});
