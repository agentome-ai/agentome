import { expect, test, type Page } from '@playwright/test';
import { api, approvals, mockApi } from './mock-api';
import { liveRuns, sse } from './mock-runs';

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.beforeEach(({ page }) => mockApi(page));

const pages = [
  '/',
  '/approvals',
  '/agents',
  '/agents/a1',
  '/tasks',
  '/tasks/k1',
  '/admin/people',
  '/admin/computers',
  '/admin/connections',
  '/projects',
  '/projects/p1',
  '/library',
  '/library?server=m1',
  '/runs',
  '/runs/r1',
  '/runs/r3',
  '/runs/r4',
  ...Object.values(liveRuns).map(({ run }) => `/runs/${run.id}`),
  '/setup',
  '/login',
  '/invite/sample-token',
];
for (const path of [...pages, '/styleguide']) {
  test(`${path} renders without console errors or sideways scroll at 1280`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    expect(errors).toEqual([]);
  });
}

/**
 * How far the content of the transcript and of the margin reaches, with whatever is open; what
 * a code block holds reaches as far as the block, which scrolls it.
 */
const layout = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector('section[aria-labelledby="transcript"]');
    const margin = document.querySelector('aside[aria-label="About this run"]');
    if (!transcript || !margin) throw new Error('Not a run page');
    const right = (root: Element) =>
      Math.max(
        ...[...root.querySelectorAll('*:not(pre *)')].map(
          (node) => node.getBoundingClientRect().right,
        ),
      );
    return {
      transcriptRight: right(transcript),
      marginLeft: margin.getBoundingClientRect().left,
      marginRight: margin.getBoundingClientRect().right,
      marginOverflow: margin.scrollWidth - margin.clientWidth,
      contentRight: right(margin),
    };
  });

const { changelog } = liveRuns;

// Notes that end with what the CLI printed, an API error's request id: the live run plus these.
const request = `req_${'0123456789abcdef'.repeat(6)}`;
const at = '2026-10-21T11:34:46.000Z';
const notes = [
  ['push_failed', `The agent's commits could not be kept: ${request}`, false],
  [
    'exit_1',
    `Claude Code exited without a result. API Error: 529 {"request_id":"${request}"}`,
    true,
  ],
].map(([code, message, fatal], i) => ({ seq: 16 + i, at, type: 'error', code, message, fatal }));

for (const width of [1280, 1536]) {
  test(`a long command stays in the transcript column at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(`**/api/runs/${changelog.run.id}/stream*`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: sse([...changelog.events, ...notes], 'done').sse,
      }),
    );
    await page.goto(`/runs/${changelog.run.id}`);
    await expect(page.getByText(/^Claude Code exited without a result/)).toBeVisible();
    // The calls between two messages are one row; it opens to each of them.
    await page.getByRole('button', { name: /^3 steps/ }).click();
    // A Bash call with a heredoc commit message, and a path longer than the column.
    await page.getByRole('button', { name: /^Commit the changelog git add/ }).click();
    await page.getByRole('button', { name: /^Wrote / }).click();
    await expect(page.getByLabel('Command of Bash')).toContainText('Co-Authored-By');
    // Housekeeping is one line until someone opens it, each where it came.
    await expect(page.getByText('rate_limit_event')).toHaveCount(0);
    await page.getByRole('button', { name: '1 system event' }).first().click();
    await expect(page.getByRole('button', { name: 'rate_limit_event' })).toBeVisible();
    const box = await layout(page);
    expect(box.transcriptRight).toBeLessThanOrEqual(box.marginLeft);
    expect(box.marginOverflow).toBe(0);
  });
}

test('a report the transcript does not end with wraps, and its code scrolls in the margin', async ({
  page,
}) => {
  const id = changelog.run.id;
  const text = [
    'Kept at https://git.example.com/acme/payments-api/-/tree/agentome/ee2e51b8-5a0c-4fa5-92af-42289c660896',
    '```',
    'git push origin agentome/ee2e51b8-5a0c-4fa5-92af-42289c660896:refs/heads/agentome/ee2e51b8',
    '```',
  ].join('\n\n');
  const report = { id: 'x-report', kind: 'report', ref: 'result', meta: { text } };
  await page.route(`**/api/runs/${id}`, (route) =>
    route.fulfill({ json: { ...changelog.run, artifacts: [report] } }),
  );
  await page.goto(`/runs/${id}`);
  const margin = page.getByRole('complementary', { name: 'About this run' });
  const code = margin.locator('pre');
  await expect(code).toContainText('git push origin');
  const box = await layout(page);
  expect(box.marginOverflow).toBe(0);
  expect(box.contentRight).toBeLessThanOrEqual(box.marginRight);
  // The code block scrolls inside the margin rather than being cut.
  expect(await code.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});

test('⌘K opens the palette from the keyboard and goes to a page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Go to a page' })).toBeVisible();
  await page.keyboard.type('appro');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
});

test('approvals: the queue in words, Approve, then nothing waiting', async ({ page }) => {
  let waiting = [...approvals];
  const decided: string[] = [];
  await mockApi(page, { ...api });
  await page.route('**/api/approvals', (route) => route.fulfill({ json: { approvals: waiting } }));
  await page.route('**/api/tool-calls/*/*', (route) => {
    const [, id, action] = /tool-calls\/([^/]+)\/(\w+)$/.exec(route.request().url()) ?? [];
    decided.push(`${action} ${id}`);
    waiting = waiting.filter((call) => call.id !== id);
    return route.fulfill({
      json: { decision: action === 'approve' ? 'approved' : 'denied', reason: null },
    });
  });
  await page.goto('/approvals');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByRole('link', { name: /Approvals/ })).toContainText('2');
  // An inbox: the requests on the left, the one picked on the right.
  const queue = page.getByRole('list', { name: 'Waiting for you' });
  const first = queue.getByRole('listitem').filter({
    hasText: /Open a pull request to acme\/checkout from agent\/fix-checkout-total/,
  });
  await expect(first).toContainText('Checkout QA');
  await expect(
    queue.getByRole('listitem').filter({
      hasText:
        /Create the branch agent\/release-notes-2-14 in payments\/services\/docs from the default branch/,
    }),
  ).toBeVisible();
  // The oldest is picked: what the agent wrote and where it comes from.
  const request = page.getByRole('article', { name: 'Request' });
  await expect(request).toContainText('compared totals as floats');
  await expect(request.getByRole('link', { name: 'Open the run' })).toBeVisible();

  await request.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(first).toHaveCount(0);
  // The request that took its place is picked, and D denies it from the keyboard.
  await expect(request).toContainText('Create the branch');
  await page.keyboard.press('d');
  const dialog = page.getByRole('dialog', { name: 'Deny this request?' });
  await dialog.getByLabel('Reason (optional)').fill('Wait for the 2.14 tag.');
  await dialog.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing is waiting for you' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Approvals/ })).not.toContainText(/\d/);
  expect(decided).toEqual(['approve tc1', 'deny tc2']);
});

test("an agent's question and its offered answers fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const question = {
    ...approvals[0],
    id: 'q1',
    tool: 'ask_owner',
    input: {
      question:
        'Насколько номер образца может быть меньше названия: «не меньше названия или чуть меньше» из пункта 2?',
      options: [
        'а) не меньше 80% размера названия, как на образцах от 27.10.2026',
        'б) не меньше 90%',
        'в) ровно как название',
      ],
    },
  };
  await page.route('**/api/approvals', (route) =>
    route.fulfill({ json: { approvals: [question] } }),
  );
  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  const offered = page.getByRole('button', { name: /не меньше 80%/ });
  const box = await offered.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
});

for (const path of ['/teams/t1', '/projects/p1', '/tasks/k1', '/agents/a1']) {
  test(`${path} has no sideways scroll on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}
