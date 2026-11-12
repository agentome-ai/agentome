import { test, type Page } from '@playwright/test';
import { api, deliveryTeam, mockApi, paymentsBackend } from './mock-api';
import { liveRuns, runRoutes, sse } from './mock-runs';

// Screenshots for pull requests and design reviews, not assertions:
// pnpm --filter @agentome/web screenshots, files land in apps/web/screenshots/.
const sizes = [
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  // Ultrawide: CLAUDE.md asks for layouts from 1280 up without stretching or drifting.
  { width: 2560, height: 1440 },
];
const dir = 'screenshots';
const pages = [
  ['setup', '/setup', 'Set up Agentome'],
  ['login', '/login', 'Sign in to Agentome'],
  ['invite', '/invite/sample-token', 'Join Agentome'],
  ['admin', '/admin', 'Admin'],
  ['license', '/admin/license', 'License'],
  ['people', '/admin/people', 'People'],
  ['projects', '/projects', 'Projects'],
  ['project', '/projects/p1', 'Payments'],
  ['connections', '/admin/connections', 'Connections'],
  ['models', '/admin/models', 'Models'],
  ['logs', '/admin/logs', 'Logs'],
  ['library', '/library', 'Library'],
] as const;

/** A run's events are in: its first line, or under a plan the folded transcript. */
const eventsIn = (page: Page) =>
  page
    .getByText(/^Claude Code [\d.]+ started/)
    .or(page.getByRole('button', { name: 'Transcript', expanded: false }))
    .first()
    .waitFor();

/** Opens the rows that fold a run's calls between two messages, so that each call shows. */
async function openSteps(page: Page) {
  // A live run's events stream in after the page: the rows are there once the start is.
  await eventsIn(page);
  const folded = page.getByRole('button', { name: 'Transcript', expanded: false });
  if (await folded.count()) await folded.click();
  await page.getByText(/^Claude Code [\d.]+ started/).waitFor();
  const rows = page.getByRole('button', { name: /^\d+ (steps|commands|files|searches)/ });
  for (const row of await rows.all()) {
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
  }
}

async function shoot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  // Overlays fade in for 180 ms: without this, a dialog can be caught still transparent.
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}

for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`${theme} ${size.width}`, async ({ page }) => {
      await mockApi(page);
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await page.goto('/');
      await shoot(page, `shell-${theme}-${size.width}`);
      if (size.width === 1536) {
        await page.getByRole('button', { name: 'Collapse sidebar' }).click();
        await shoot(page, `shell-collapsed-${theme}`);
        await page.getByRole('button', { name: 'Expand sidebar' }).click();
      }
      for (const [name, path, heading] of pages) {
        await page.goto(path);
        await page.getByRole('heading', { level: 1, name: heading }).waitFor();
        if (name === 'people') await page.getByText('Pending invitations').waitFor();
        if (name === 'admin') await page.getByText('Agentome 0.2.0 is out.').waitFor();
        await shoot(page, `${name}-${theme}-${size.width}`);
      }
      await page.goto('/styleguide');
      await page.getByTestId('sheet-pass').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `${dir}/styleguide-${theme}-${size.width}.png`,
        fullPage: true,
      });
      if (size.width !== 1536) return;

      // States that only show after an action.
      await page.goto('/setup');
      await page.getByRole('button', { name: 'Create the administrator account' }).click();
      await shoot(page, `setup-errors-${theme}`);
      await page.goto('/agents/a1');
      await page.getByRole('link', { name: 'Tools & policies' }).click();
      await page.getByRole('group', { name: 'tracker' }).waitFor();
      await shoot(page, `agent-tools-${theme}`);
      await page.goto('/library');
      await page.getByRole('button', { name: /^tracker/ }).click();
      await page.getByRole('article', { name: 'tracker' }).getByText('Create an issue').waitFor();
      await shoot(page, `library-server-${theme}`);
      await page
        .getByRole('article', { name: 'tracker' })
        .getByRole('button', { name: 'Edit' })
        .click();
      await page.getByRole('dialog', { name: 'Edit tracker' }).waitFor();
      await shoot(page, `library-server-edit-${theme}`);
      await page.keyboard.press('Escape');
      await page.goto('/admin/people');
      await page.getByRole('button', { name: 'Invite someone' }).click();
      await page.getByRole('button', { name: 'Create link' }).click();
      await page.getByLabel('Invitation link').waitFor();
      await shoot(page, `people-invite-link-${theme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Actions for Maria Garcia' }).click();
      await page.getByRole('menuitem', { name: 'Disable' }).click();
      await page.getByRole('dialog', { name: 'Disable Maria Garcia?' }).waitFor();
      await shoot(page, `people-disable-${theme}`);

      // Taller than any sheet, so the sticky page header never lands inside an element shot.
      await page.goto('/styleguide');
      await page.setViewportSize({ width: 1536, height: 2400 });
      for (const sheet of ['sheet-pass', 'sheet-compact', 'sheet-new']) {
        await page.getByTestId(sheet).screenshot({ path: `${dir}/${sheet}-${theme}.png` });
      }
    });
  }
}

// Admin, Computers with a fake API: a busy computer, one gone quiet and one revoked.
async function fakeSeatsApi(page: Page) {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const laptop = {
    kind: 'subscription-laptop',
    status: 'active',
    activeRun: null,
    updateCommand: null,
    signedOut: [],
    platform: null,
    sandbox: { none: false, allowedAt: null },
  };
  await page.route('**/api/seats', (route) =>
    route.fulfill({
      json: [
        {
          ...laptop,
          id: 's1',
          name: 'Maria’s MacBook Pro',
          owner: { id: 'u3', name: 'Maria Garcia' },
          lastSeenAt: ago(12),
          activeRun: { id: 'r1', agentName: 'Backend developer', startedAt: ago(720) },
        },
        {
          ...laptop,
          id: 's2',
          name: 'maria-home-mini',
          owner: { id: 'u3', name: 'Maria Garcia' },
          lastSeenAt: ago(5 * 3600),
        },
        {
          ...laptop,
          id: 's3',
          name: 'old-thinkpad',
          owner: { id: 'u1', name: 'Ann Admin' },
          status: 'revoked',
          lastSeenAt: ago(40 * 86400),
        },
      ],
    }),
  );
  await page.route('**/api/seats/pairing-codes', (route) =>
    route.fulfill({
      status: 201,
      json: {
        code: 'K7QX-M2PH',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        command: 'curl -fsSL https://agentome.northfold.dev/connect | sh -s -- K7QX-M2PH',
        checkout: false,
      },
    }),
  );
}

for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`seats ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      // The person first; the seats answers, registered later, take precedence.
      await mockApi(page);
      await fakeSeatsApi(page);
      await page.goto('/admin/computers');
      await page.getByRole('row', { name: /old-thinkpad/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${dir}/seats-${theme}-${size.width}.png` });
      if (size.width === 1280 || size.width === 1536) {
        await page.getByRole('button', { name: 'Connect a computer' }).click();
        await page.getByText('K7QX-M2PH', { exact: true }).waitFor();
        // The dialog fades in; the shot waits for it to settle.
        await page
          .getByRole('dialog')
          .evaluate((node) => Promise.all(node.getAnimations().map((motion) => motion.finished)));
        await page.screenshot({ path: `${dir}/seats-connect-${theme}-${size.width}.png` });
      }
    });
  }
}

// Agents: the list, the editor with its sheet, an unsaved edit, the preview and New agent.
for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`agents ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await mockApi(page);
      await page.goto('/agents');
      await page.getByRole('row', { name: /Payments backend/ }).waitFor();
      await shoot(page, `agents-${theme}-${size.width}`);
      await page.goto('/agents/a1');
      await page.getByRole('complementary', { name: /^Agent sheet/ }).waitFor();
      await shoot(page, `agent-editor-${theme}-${size.width}`);
      await page.getByRole('region', { name: 'Quality' }).getByText('At the first go').waitFor();
      await page.getByRole('region', { name: 'Quality' }).scrollIntoViewIfNeeded();
      await shoot(page, `agent-quality-${theme}-${size.width}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (size.width !== 1280 && size.width !== 1536) return;

      // Transfer ownership: to whom, and the days it can come back on.
      await page.getByRole('button', { name: 'Transfer ownership' }).click();
      const transfer = page.getByRole('dialog', { name: 'Transfer Payments backend' });
      await transfer.getByRole('combobox', { name: 'New owner' }).click();
      await page.getByRole('option', { name: 'Maria Garcia' }).click();
      await settle(page);
      await shoot(page, `agent-transfer-${theme}-${size.width}`);
      // The day it comes back, in the kit's calendar: any day from tomorrow on.
      await transfer.getByRole('button', { name: 'Comes back' }).click();
      await page.getByRole('grid').waitFor();
      // The open calendar hides the dialog from the accessibility tree: wait out its fade by time.
      await page.waitForTimeout(300);
      await shoot(page, `agent-transfer-term-${theme}-${size.width}`);
      await page.getByRole('grid').getByRole('button').last().click();
      await settle(page);
      await shoot(page, `agent-transfer-until-${theme}-${size.width}`);
      await page.keyboard.press('Escape');

      await page.getByLabel('Name', { exact: true }).fill('Payments backend, EU');
      await page.getByLabel('Monthly limit, USD').fill('400');
      await shoot(page, `agent-editor-unsaved-${theme}-${size.width}`);
      await page.getByRole('button', { name: 'Preview workspace' }).click();
      await settle(page);
      await shoot(page, `agent-preview-${theme}-${size.width}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Discard' }).click();
      await page.goto('/agents');
      await page.getByRole('button', { name: 'New agent' }).click();
      await page.getByRole('radio', { name: 'Code reviewer' }).waitFor();
      await settle(page);
      await shoot(page, `agent-new-${theme}-${size.width}`);
    });
  }
}

// Tasks: the list, a task with a run going and one at rest, and New task as an agent's Run
// opens it: as it opens, and with a repository it refuses.
for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`tasks ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await mockApi(page);
      await page.goto('/tasks');
      await page.getByRole('row', { name: /Add a README/ }).waitFor();
      await shoot(page, `tasks-${theme}-${size.width}`);
      await page.goto('/tasks/k1');
      await page.getByRole('heading', { name: 'Done when' }).waitFor();
      await shoot(page, `task-${theme}-${size.width}`);
      await page.goto('/');
      // The card of the project at work, once its run's plan is read from the run's events.
      await page.getByRole('article', { name: 'Payments' }).getByText('1 of 4 done').waitFor();
      await page.getByRole('region', { name: 'Recent activity' }).waitFor();
      await shoot(page, `dashboard-${theme}-${size.width}`);
      if (size.width !== 1280 && size.width !== 1536) return;

      await page.goto('/tasks/k5');
      await page.getByRole('button', { name: 'Run again' }).waitFor();
      await shoot(page, `task-idle-${theme}-${size.width}`);
      // The thread: the run's report and the comments, down to the composer.
      await page.getByRole('form', { name: 'Comment' }).scrollIntoViewIfNeeded();
      // The markdown renderer loads after the page: until then the text shows as it was written.
      await page.locator('code', { hasText: 'webhook_attempts' }).waitFor();
      await shoot(page, `task-thread-${theme}-${size.width}`);
      // The description changed where it is read.
      await page.getByRole('button', { name: 'Edit description' }).click();
      await page.getByRole('textbox', { name: 'Description' }).waitFor();
      await shoot(page, `task-edit-${theme}-${size.width}`);
      await page.goto('/agents/a1');
      const sheet = page.getByRole('complementary', { name: /^Agent sheet/ });
      await sheet.getByRole('button', { name: 'Run', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New task' });
      await dialog.getByRole('combobox', { name: 'For' }).waitFor();
      await settle(page);
      await shoot(page, `task-new-${theme}-${size.width}`);
      // Create without a title says what is missing, under the chips.
      await dialog.getByRole('button', { name: 'Create and run' }).click();
      await dialog.getByText('Enter a title for the task.').waitFor();
      await shoot(page, `task-new-error-${theme}-${size.width}`);
      await dialog.getByLabel('Title').fill('Add a README to the test repository');
      await dialog
        .getByLabel('Description')
        .fill('Say what the service does, and how to install, test and run it.');
      // Where it works, with a path of one's own typed in.
      await dialog.getByRole('button', { name: /^Where it works/ }).click();
      await page
        .getByRole('combobox', { name: 'Folder path or repository URL' })
        .fill('~/code/refunds');
      await page.waitForTimeout(300);
      await shoot(page, `task-new-repository-${theme}-${size.width}`);
    });
  }
}

/** Waits for the open dialog to finish fading in. */
async function settle(page: Page) {
  await page
    .getByRole('dialog')
    .evaluate((node) => Promise.all(node.getAnimations().map((motion) => motion.finished)));
}

// Runs with the mock API: the list, then a running, a finished and a failed run, and the first
// live runs as they were recorded.
const changelog = liveRuns.changelog.run;
const instructions = liveRuns.instructions.run;
const runPages = [
  ['runs', '/runs', 'Runs'],
  ['run-running', '/runs/r1', 'Fix the flaky retry test in payments-api'],
  ['run-done', '/runs/r3', 'Add a README to the test repository'],
  ['run-failed', '/runs/r4', 'Fix the checkout end-to-end suite'],
  ['run-live-changelog', `/runs/${changelog.id}`, changelog.task.title],
  ['run-live-instructions', `/runs/${instructions.id}`, instructions.task.title],
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`runs ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await mockApi(page);
      for (const [name, path, heading] of runPages) {
        await page.goto(path);
        await page.getByRole('heading', { level: 1, name: heading }).waitFor();
        if (name !== 'runs') await eventsIn(page);
        await shoot(page, `${name}-${theme}-${size.width}`);
      }
      if (size.width !== 1536 && size.width !== 1280) return;

      // The long call of the live run opened, with its housekeeping; and a report that the
      // transcript does not end with, whose code scrolls inside the margin.
      await page.goto(`/runs/${changelog.id}`);
      await openSteps(page);
      await page.getByRole('button', { name: /^Commit the changelog git add/ }).click();
      await page.getByRole('button', { name: '1 system event' }).last().click();
      await page.mouse.move(0, 0);
      await shoot(page, `run-live-open-${theme}-${size.width}`);
      const text = [
        'The commit is in the branch:',
        '',
        '```',
        `git log --oneline agentome/${changelog.id}`,
        'ffa9994 Add CHANGELOG.md in Keep a Changelog format',
        '```',
      ].join('\n');
      await page.route(`**/api/runs/${changelog.id}`, (route) =>
        route.fulfill({
          json: {
            ...changelog,
            artifacts: [{ id: 'x-report', kind: 'report', ref: 'result', meta: { text } }],
          },
        }),
      );
      await page.goto(`/runs/${changelog.id}`);
      await page.getByRole('complementary', { name: 'About this run' }).locator('pre').waitFor();
      await shoot(page, `run-report-text-${theme}-${size.width}`);
      await page.unroute(`**/api/runs/${changelog.id}`);
      if (size.width !== 1536) return;

      // A tool call opened, and the Cancel dialog.
      await page.goto('/runs/r1');
      await openSteps(page);
      await page.getByRole('button', { name: /pnpm vitest run/ }).click();
      await page.getByRole('button', { name: /^Read settlement/ }).click();
      await shoot(page, `run-tool-open-${theme}`);
      await page.getByRole('button', { name: 'Cancel run' }).click();
      await settle(page);
      await shoot(page, `run-cancel-${theme}`);
    });
  }
}

// Approvals: the queue, the Deny dialog, and the editor's policies the queue follows.
for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`approvals ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await mockApi(page);
      await page.goto('/approvals');
      await page.getByRole('list', { name: 'Waiting for you' }).waitFor();
      // The inbox, the oldest request picked: what the agent wrote and where it comes from.
      await page.getByRole('article', { name: 'Request' }).waitFor();
      await shoot(page, `approvals-${theme}-${size.width}`);
      await page
        .getByRole('article', { name: 'Request' })
        .getByRole('button', { name: 'Deny' })
        .click();
      await page.getByRole('dialog', { name: 'Deny this request?' }).waitFor();
      await shoot(page, `approvals-deny-${theme}-${size.width}`);
      if (size.width !== 1536) return;
      await page.goto('/agents/a1');
      await page.getByRole('group', { name: 'Code host' }).scrollIntoViewIfNeeded();
      await shoot(page, `agent-policies-${theme}-${size.width}`);
      // The memory: the documents, one opened, and its history with the change from before.
      const memorySection = page.getByRole('region', { name: 'Memory' });
      await memorySection.scrollIntoViewIfNeeded();
      await shoot(page, `agent-memory-${theme}-${size.width}`);
      await memorySection.getByRole('button', { name: /MEMORY.md/ }).click();
      await settle(page);
      await page.getByRole('dialog').getByRole('heading', { name: 'Payments backend' }).waitFor();
      await shoot(page, `agent-memory-open-${theme}-${size.width}`);
      await page.getByRole('tab', { name: 'History' }).click();
      await page.getByLabel('Changes').waitFor();
      await shoot(page, `agent-memory-history-${theme}-${size.width}`);
    });
  }
}

// A team: the lead's Team section in manual steps, and a run with an assignment open.
const at = '2026-10-27T10:00:00.000Z';
const lead = 'toolu_lead';
const teamEvents = [
  { seq: 0, at, type: 'assistant_message', text: 'I will split this between QA and the docs.' },
  {
    seq: 1,
    at,
    type: 'tool_use',
    id: lead,
    name: 'Agent',
    input: {
      subagent_type: 'checkout-qa',
      description: 'Test the refund flow end to end',
      prompt: 'Run the checkout e2e suite against the refund branch and report failures.',
    },
  },
  { seq: 2, at, type: 'assistant_message', text: 'Running the suite.', parentToolUseId: lead },
  {
    seq: 3,
    at,
    type: 'tool_use',
    id: 'toolu_m1',
    name: 'Bash',
    input: { command: 'pnpm e2e checkout', description: 'Run the checkout e2e suite' },
    parentToolUseId: lead,
  },
  {
    seq: 4,
    at,
    type: 'tool_result',
    toolUseId: 'toolu_m1',
    output: '24 passed',
    isError: false,
    parentToolUseId: lead,
  },
  {
    seq: 5,
    at,
    type: 'assistant_message',
    text: 'All 24 refund tests pass.',
    parentToolUseId: lead,
  },
  {
    seq: 6,
    at,
    type: 'tool_result',
    toolUseId: lead,
    output: 'All 24 refund tests pass.',
    isError: false,
  },
  { seq: 7, at, type: 'assistant_message', text: 'QA confirms the refund flow works.' },
  { seq: 8, at, type: 'result', text: 'QA confirms the refund flow works.', isError: false },
];
const teamRoutes = {
  ...api,
  // Billing reviewer leads Payments, in which Payments backend leads Refunds delivery.
  'GET /api/teams': {
    teams: [
      deliveryTeam,
      {
        id: 't2',
        name: 'Payments',
        mode: 'auto',
        lead: { id: 'a4', name: 'Billing reviewer', roleTitle: 'Code reviewer', status: 'active' },
        members: [deliveryTeam.lead],
        steps: [],
      },
    ],
  },
  'GET /api/agents/a1': {
    ...paymentsBackend,
    tools: [
      ...paymentsBackend.tools,
      { connector: 'Team', name: 'team_step', title: 'Start a team step', policy: 'ask' },
    ],
  },
  'GET /api/runs/r3': {
    ...(runRoutes['GET /api/runs/r3'] as object),
    team: [{ key: 'checkout-qa', agentId: 'a2', name: 'Checkout QA' }],
  },
  'GET /api/runs/r3/stream': sse(teamEvents, 'done'),
};
for (const theme of ['light', 'dark'] as const) {
  for (const size of sizes.slice(0, 4)) {
    test(`team ${theme} ${size.width}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
      await page.setViewportSize(size);
      await mockApi(page, teamRoutes);
      await page.goto('/teams');
      await page.getByRole('link', { name: 'Refunds delivery' }).waitFor();
      await shoot(page, `teams-chart-${theme}-${size.width}`);
      await page.goto('/teams?view=list');
      await page.getByRole('link', { name: 'Refunds delivery' }).waitFor();
      await shoot(page, `teams-${theme}-${size.width}`);
      await page.goto('/teams/t1');
      await page.getByRole('group', { name: 'Agents of step 2' }).waitFor();
      await shoot(page, `team-${theme}-${size.width}`);
      await page.goto('/agents/a1');
      // Below 1280 the sections have no nav: the page scrolls to the section instead.
      if (size.width >= 1280) await page.getByRole('link', { name: 'Team', exact: true }).click();
      else await page.getByRole('region', { name: 'Team' }).scrollIntoViewIfNeeded();
      await page.getByText(/^Leads/).waitFor();
      await shoot(page, `agent-team-${theme}-${size.width}`);
      await page.goto('/runs/r3');
      await page.getByRole('button', { name: /Checkout QA/ }).click();
      await page.getByText('All 24 refund tests pass.').first().waitFor();
      await shoot(page, `run-team-${theme}-${size.width}`);
    });
  }
  // A manual step waits for the owner: the assignment says so until it starts.
  test(`team step waiting ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page, {
      ...teamRoutes,
      'GET /api/runs/r3': {
        ...(teamRoutes['GET /api/runs/r3'] as object),
        status: 'waiting_approval',
        toolCalls: [
          {
            tool: 'team_step',
            agentId: 'a1',
            decision: 'pending',
            reason: null,
            decidedBy: null,
            createdAt: at,
            members: ['a2'],
          },
        ],
      },
      'GET /api/runs/r3/stream': sse(teamEvents.slice(0, 2), 'waiting_approval'),
    });
    await page.goto('/runs/r3');
    await page.getByText('Waiting for approval').first().waitFor();
    await shoot(page, `run-team-waiting-${theme}-1280`);
  });
}

// Who of a team worked when, on the shape of a real team run: 42 minutes,
// a developer called four times, a tester and a code reviewer once each.
const timeline = (() => {
  const start = Date.parse('2026-10-29T19:13:00.000Z');
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const work = [
    ['developer', 1.7, 3.8, 'PAY-164 plan', 8],
    ['developer', 4.6, 15.9, 'PAY-164 scaffold', 12],
    ['tester', 16.3, 19.0, 'PAY-164 tests before code', 8],
    ['developer', 19.2, 27.4, 'PAY-164 code steps 1-3', 13],
    ['code-reviewer', 27.6, 36.1, 'PAY-164 branch review', 10],
    ['developer', 36.2, 39.4, 'PAY-164 review nits', 5],
  ] as const;
  let seq = 0;
  const events: object[] = [
    { seq: seq++, at: at(0.2), type: 'assistant_message', text: 'I take PAY-164 by the pipeline.' },
  ];
  for (const [key, from, to, what, steps] of work) {
    const id = `toolu_${seq}`;
    events.push({
      seq: seq++,
      at: at(from),
      type: 'tool_use',
      id,
      name: 'Agent',
      input: { subagent_type: key, description: what, prompt: what },
    });
    for (let i = 0; i < steps; i++) {
      const step = `${id}_${i}`;
      const when = at(from + ((to - from) * (i + 0.5)) / steps);
      events.push(
        {
          seq: seq++,
          at: when,
          type: 'tool_use',
          id: step,
          name: 'Read',
          input: { file_path: 'src/labels.css' },
          parentToolUseId: id,
        },
        {
          seq: seq++,
          at: when,
          type: 'tool_result',
          toolUseId: step,
          output: 'ok',
          isError: false,
          parentToolUseId: id,
        },
      );
    }
    events.push({
      seq: seq++,
      at: at(to),
      type: 'tool_result',
      toolUseId: id,
      output: 'Done',
      isError: false,
    });
  }
  events.push({
    seq,
    at: at(42),
    type: 'result',
    text: 'PAY-164 is ready for review.',
    isError: false,
  });
  const team = [
    ['analyst', 'm1', 'Analyst'],
    ['developer', 'm2', 'Developer'],
    ['tester', 'm3', 'Tester'],
    ['code-reviewer', 'm4', 'Code reviewer'],
    ['security-expert', 'm5', 'Security expert'],
  ].map(([key, agentId, name]) => ({ key, agentId, name }));
  return {
    ...teamRoutes,
    'GET /api/runs/r3': {
      ...(teamRoutes['GET /api/runs/r3'] as object),
      agent: { id: 'a1', name: 'Delivery lead' },
      startedAt: at(0),
      endedAt: at(42),
      team,
    },
    'GET /api/runs/r3/stream': sse(events, 'done'),
  };
})();
for (const theme of ['light', 'dark'] as const) {
  test(`team timeline ${theme}`, async ({ page, browser }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page, timeline);
    await page.goto('/runs/r3');
    await page.getByRole('heading', { name: 'Team' }).waitFor();
    await shoot(page, `run-team-timeline-${theme}-1280`);
    await page.screenshot({
      path: `${dir}/run-team-timeline-${theme}-1280-full.png`,
      fullPage: true,
    });
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    const phone = await context.newPage();
    await mockApi(phone, timeline);
    await phone.goto('/runs/r3');
    await phone.getByRole('heading', { name: 'Team' }).waitFor();
    await phone.waitForTimeout(300);
    const width = await phone.evaluate(() => document.documentElement.scrollWidth);
    await phone.screenshot({ path: `${dir}/phone-run-team-${theme}-full.png`, fullPage: true });
    await context.close();
    if (width > 375) throw new Error(`Wider than the phone: ${width}px`);
  });
}

// API tokens, a page from the account menu: the list, then New token's composer with a custom
// expiry and its access being chosen, and on a phone the list and the composer as a sheet.
for (const theme of ['light', 'dark'] as const) {
  test(`license read-only ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    const license = api['GET /api/license'] as object;
    await mockApi(page, {
      ...api,
      'GET /api/license': {
        ...license,
        status: 'read_only',
        enterprise: false,
        id: null,
        company: null,
        expiresAt: null,
        graceEndsAt: null,
        over: ['agents', 'server_agents'],
      },
    });
    await page.goto('/');
    await page.getByText('Agentome is read-only.').waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `license-read-only-${theme}-1280`);
  });

  // Free without a key: the server and a monthly limit wait for a key, quality says so.
  test(`agent editor on Free ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    const license = api['GET /api/license'] as object;
    await mockApi(page, {
      ...api,
      'GET /api/license': {
        ...license,
        status: 'free',
        enterprise: false,
        id: null,
        company: null,
        expiresAt: null,
        graceEndsAt: null,
        over: [],
      },
      'GET /api/agents/a1/quality': {
        fail: {
          status: 403,
          code: 'license_required',
          message: "An agent's quality needs a license key.",
        },
      },
    });
    await page.goto('/agents/a1');
    await page.getByText(/Agents on the server need a license key/).waitFor();
    await page.getByText(/Agents on the server need a license key/).scrollIntoViewIfNeeded();
    await shoot(page, `agent-editor-free-${theme}-1280`);
    await page.getByText(/A monthly limit needs a license key/).scrollIntoViewIfNeeded();
    await shoot(page, `agent-editor-free-budget-${theme}-1280`);
    await page.getByText(/quality comes with a license key/).scrollIntoViewIfNeeded();
    await shoot(page, `agent-editor-free-quality-${theme}-1280`);
  });

  test(`api tokens ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Ann Admin' }).click();
    await page.getByRole('menuitem', { name: 'API tokens' }).click();
    await page.getByRole('table', { name: 'Your tokens' }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `api-tokens-page-${theme}-1280`);
    await page.getByRole('button', { name: 'New token' }).click();
    const composer = page.getByRole('dialog', { name: 'New token' });
    await composer.getByLabel('Token name').fill('Nightly CI');
    await composer.getByRole('combobox', { name: /^Expires/ }).click();
    await page.getByRole('option', { name: 'Custom' }).click();
    await composer.getByLabel('Days').fill('180');
    await settle(page);
    await shoot(page, `api-tokens-${theme}-1280`);
    await composer.getByRole('combobox', { name: /^Access/ }).click();
    await page.getByRole('option', { name: /Read only/ }).waitFor();
    await shoot(page, `api-tokens-access-${theme}-1280`);
  });

  test(`phone api tokens ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    const page = await context.newPage();
    await mockApi(page);
    await page.goto('/more');
    await page.getByRole('main').getByRole('link', { name: 'API tokens' }).click();
    await page.getByRole('table', { name: 'Your tokens' }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `phone-api-tokens-${theme}`);
    await page.getByRole('button', { name: 'New token' }).click();
    await page
      .getByRole('dialog', { name: 'New token' })
      .getByLabel('Token name')
      .fill('Nightly CI');
    await settle(page);
    await shoot(page, `phone-api-tokens-new-${theme}`);
    await context.close();
  });
}

// Notifications and Account, pages from the account menu: notifications off on a desktop
// browser, and Safari on an iPhone, which sends the person to the Home Screen first.
for (const theme of ['light', 'dark'] as const) {
  test(`notifications ${theme}`, async ({ page }) => {
    // Headless Chromium answers denied whatever is granted: here it has not been asked yet.
    await page.addInitScript(() =>
      Object.defineProperty(Notification, 'permission', { get: () => 'default' }),
    );
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Ann Admin' }).click();
    await page.getByRole('menuitem', { name: 'Notifications' }).click();
    await page.getByRole('switch', { name: 'Push notifications', disabled: false }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `notifications-${theme}-1280`);
    await page.getByRole('button', { name: 'Ann Admin' }).click();
    await page.getByRole('menuitem', { name: 'Account' }).click();
    await page.getByLabel('Name').waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `account-${theme}-1280`);
  });
}

test('notifications on an iPhone', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  // Safari outside the Home Screen app has no Push API.
  await context.addInitScript(() => Reflect.deleteProperty(window, 'PushManager'));
  const page = await context.newPage();
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'More' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Notifications' }).click();
  await page.getByText(/Add to Home Screen/).waitFor();
  await page.waitForTimeout(300);
  await shoot(page, 'notifications-iphone-390');
  await page.goto('/more');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Account/ })
    .click();
  await page.getByLabel('Name').waitFor();
  await page.waitForTimeout(300);
  await shoot(page, 'account-iphone-390');
  await context.close();
});

// Admin → Models: New model connection for a gateway, the company's LiteLLM, and a connection's models.
for (const theme of ['light', 'dark'] as const) {
  test(`model connections ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page);
    await page.goto('/admin/models');
    await page.getByRole('button', { name: 'New connection' }).click();
    const composer = page.getByRole('dialog', { name: 'New model connection' });
    await composer.getByLabel('Name').fill('Northfold LiteLLM');
    await composer.getByLabel('Address').fill('https://litellm.northfold.dev');
    await composer.getByLabel('API key').fill('sk-not-a-real-key');
    await settle(page);
    await shoot(page, `models-new-${theme}-1280`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Northfold LiteLLM, Gateway' }).click();
    await page.getByRole('dialog', { name: 'Northfold LiteLLM' }).waitFor();
    await settle(page);
    await shoot(page, `models-list-${theme}-1280`);
  });
}

// A Jira connection: the list with one, and New connection filled in for Jira.
for (const theme of ['light', 'dark'] as const) {
  test(`jira connection ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page);
    await page.goto('/admin/connections');
    await page.getByText('jira.northfold.dev: project = "PAY" AND (labels = ai-team)').waitFor();
    await shoot(page, `connections-jira-${theme}-1280`);
    await page.getByRole('button', { name: 'New connection' }).click();
    const dialog = page.getByRole('dialog', { name: 'New connection' });
    await dialog.getByLabel('Jira', { exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Issues go to' }).click();
    await page.getByRole('option', { name: 'Payments backend' }).click();
    await dialog.getByLabel('Jira address').fill('https://jira.northfold.dev');
    await dialog.getByLabel('Project key').fill('PAY');
    await dialog.getByLabel('Filter (optional)').fill('labels = ai-team');
    await settle(page);
    await shoot(page, `connection-new-jira-${theme}-1280`);
  });
}

// A project's services from its devcontainer, and an admin approving them.
for (const theme of ['light', 'dark'] as const) {
  test(`project services ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page);
    await page.goto('/projects/p1');
    const services = page.getByRole('list', { name: 'Services' });
    await services.getByText('postgres:16-alpine').waitFor();
    await services.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shoot(page, `project-services-${theme}-1280`);
    await page.getByRole('button', { name: 'Approve services' }).click();
    await page.getByRole('dialog', { name: 'Approve these services?' }).waitFor();
    await settle(page);
    await shoot(page, `project-services-approve-${theme}-1280`);
  });
}

// A project's repositories, and New task starting in the agent's main one.
for (const theme of ['light', 'dark'] as const) {
  test(`project repositories ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page);
    await page.goto('/projects/p1');
    await page.getByText('github.com/northfold/ledger', { exact: true }).waitFor();
    await shoot(page, `project-repositories-${theme}-1280`);
    // Its fields as chips: who starts a task, as a menu.
    await page.getByRole('button', { name: /^Who starts a task/ }).click();
    await page.getByRole('menuitemradio', { name: /The lead takes it/ }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `project-intake-${theme}-1280`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add repository' }).click();
    await page.getByLabel('URL').fill('https://github.com/northfold/refunds');
    await settle(page);
    await shoot(page, `project-repository-add-${theme}-1280`);
    // New task from the project: the composer of Tasks, the project and its team chosen.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New task' }).click();
    const fromProject = page.getByRole('dialog', { name: 'New task' });
    await fromProject.getByRole('combobox', { name: 'Project: Payments' }).waitFor();
    await settle(page);
    await shoot(page, `project-new-task-${theme}-1280`);
    // Where it works: the person's folders, or the project's repositories.
    await fromProject.getByRole('button', { name: /^Where it works/ }).click();
    await page.getByRole('option', { name: '~/code/payments' }).click();
    await page.waitForTimeout(300);
    await shoot(page, `project-new-task-folder-${theme}-1280`);
    await fromProject.getByRole('button', { name: /^Where it works/ }).click();
    await page.getByRole('option', { name: /Main/ }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `project-new-task-where-${theme}-1280`);
    await page.keyboard.press('Escape');
    await page.goto('/agents/a1');
    const sheet = page.getByRole('complementary', { name: /^Agent sheet/ });
    await sheet.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByRole('button', { name: /^Where it works/ }).click();
    await page.getByRole('option', { name: 'northfold/ledger' }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `task-new-repositories-${theme}-1280`);
  });
}

// A phone: the pages a push opens and the ones used on the go, at 375 px with touch. Each
// must fit the width; a page wider than the screen fails the run.
const phonePages = [
  ['dashboard', '/', 'Dashboard'],
  ['tasks', '/tasks', 'Tasks'],
  ['task', '/tasks/k1', 'Add a README'],
  ['task-thread', '/tasks/k5', 'Retry webhook deliveries with backoff'],
  ['runs', '/runs', 'Runs'],
  ['run', '/runs/r1', 'Fix the flaky retry test in payments-api'],
  ['run-done', '/runs/r3', 'Add a README to the test repository'],
  ['approvals', '/approvals', 'Approvals'],
  ['license', '/admin/license', 'License'],
  ['agents', '/agents', 'Agents'],
  ['agent', '/agents/a1', ''],
  ['teams', '/teams', 'Teams'],
  ['team', '/teams/t1', 'Refunds delivery'],
  ['projects', '/projects', 'Projects'],
  ['project', '/projects/p1', 'Payments'],
  ['library', '/library', 'Library'],
  ['admin', '/admin', 'Admin'],
  ['people', '/admin/people', 'People'],
  ['seats', '/admin/computers', 'Computers'],
  ['connections', '/admin/connections', 'Connections'],
  ['models', '/admin/models', 'Models'],
] as const;

for (const theme of ['light', 'dark'] as const) {
  test(`phone ${theme}`, async ({ browser }) => {
    // Every page at phone width, then the sheets: longer than the default 30 s.
    test.setTimeout(120_000);
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    const page = await context.newPage();
    await mockApi(page);
    const wide: string[] = [];
    for (const [name, path, heading] of phonePages) {
      await page.goto(path);
      if (heading) await page.getByRole('heading', { level: 1, name: heading }).first().waitFor();
      else await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 375) wide.push(`${name}: ${width}px`);
      await shoot(page, `phone-${name}-${theme}`);
      await page.screenshot({ path: `${dir}/phone-${name}-${theme}-full.png`, fullPage: true });
    }
    // New connection, with the systems as tabs.
    await page.goto('/admin/connections');
    await page.getByRole('button', { name: 'New connection' }).click();
    await page.getByRole('dialog').getByLabel('Jira', { exact: true }).click();
    await settle(page);
    await shoot(page, `phone-connection-${theme}`);
    // New task, as a sheet over the whole screen.
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New task' }).click();
    await page
      .getByRole('dialog', { name: 'New task' })
      .getByRole('combobox', { name: /^For/ })
      .waitFor();
    await settle(page);
    await shoot(page, `phone-new-task-${theme}`);
    // As tall as what is in it: the description grows as it is filled.
    const sheet = page.getByRole('dialog', { name: 'New task' });
    await sheet.getByLabel('Title').fill('Add a README to the payments API');
    await sheet
      .getByLabel('Description')
      .fill(
        'Say what the service does, how to install it, how to test it and how to run it locally and in staging.',
      );
    await shoot(page, `phone-new-task-filled-${theme}`);
    // A comment on a task, from the bar above the tab bar.
    await page.goto('/tasks/k5');
    await page.getByRole('button', { name: /^Write to / }).click();
    await page.getByRole('dialog', { name: 'Comment' }).getByRole('textbox').fill('Retry 5 times.');
    await settle(page);
    await shoot(page, `phone-task-comment-${theme}`);
    // More, opened from the tab bar as a screen of its own, and a page picked on it.
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Tabs' })
      .getByRole('link', { name: 'More' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'More' }).waitFor();
    await page.waitForTimeout(300);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width > 375) wide.push(`more: ${width}px`);
    await shoot(page, `phone-menu-${theme}`);
    await page.getByRole('main').getByRole('link', { name: 'Library' }).click();
    await page.getByRole('heading', { level: 1, name: 'Library' }).waitFor();
    await context.close();
    if (wide.length > 0) throw new Error(`Wider than the phone: ${wide.join(', ')}`);
  });
}

// The splash on a phone's first open: the logo for two seconds, over the loaded page.
for (const theme of ['light', 'dark'] as const) {
  test(`phone splash ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => {
      localStorage.setItem('agentome-theme', value);
      // Automated browsers skip the splash; this one stands for a person's phone.
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    }, theme);
    const page = await context.newPage();
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();
    await shoot(page, `phone-splash-${theme}`);
    await page.locator('#splash').waitFor({ state: 'detached', timeout: 5000 });
    // A reload in the same tab goes straight to the page.
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Dashboard' }).waitFor();
    if (await page.locator('html.splash').count()) throw new Error('The splash showed on reload');
    await context.close();
  });
}

// A phone's empty pages: what will land there drawn faint over the words.
for (const theme of ['light', 'dark'] as const) {
  test(`phone empty ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    const page = await context.newPage();
    await mockApi(page, {
      ...api,
      'GET /api/approvals': { approvals: [] },
      'GET /api/tasks': { tasks: [], nextBefore: null },
      'GET /api/runs': { runs: [], nextBefore: null },
    });
    for (const [name, path, heading] of [
      ['approvals', '/approvals', 'Nothing is waiting for you'],
      ['tasks', '/tasks', 'No open tasks'],
      ['runs', '/runs', 'Nothing is running'],
    ] as const) {
      await page.goto(path);
      await page.getByRole('heading', { name: heading }).waitFor();
      await page.waitForTimeout(300);
      await shoot(page, `phone-empty-${name}-${theme}`);
    }
    await context.close();
  });
}

// Admin → Logs: a line open with its context, and a trace as a waterfall.
for (const theme of ['light', 'dark'] as const) {
  test(`logs ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    await page.setViewportSize({ width: 1536, height: 864 });
    await mockApi(page);
    await page.goto('/admin/logs');
    const lines = page.getByRole('list', { name: 'Log lines' });
    await lines.getByRole('button').first().click();
    await shoot(page, `logs-open-${theme}-1536`);
    await page.goto('/admin/logs/traces/a1b2c3d4e5f60718');
    await page.getByRole('region', { name: 'Waterfall' }).waitFor();
    await shoot(page, `logs-trace-${theme}-1536`);
  });

  // On a phone a request reads as its method, path and answer.
  test(`phone logs ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((value) => localStorage.setItem('agentome-theme', value), theme);
    const page = await context.newPage();
    await mockApi(page);
    await page.goto('/admin/logs');
    await page.getByRole('list', { name: 'Log lines' }).waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `phone-logs-${theme}`);
    await context.close();
  });
}
