import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, test, type Page } from '@playwright/test';

// Runs with playwright.flow.config.ts against the real server and an empty database. The
// flows build on each other, in order: the first one sets the installation up.
test.describe.configure({ mode: 'serial' });

const adminPassword = `admin-${randomUUID()}`;
const memberPassword = `member-${randomUUID()}`;
// The admin's signed-in browser state, for the flows after the first.
let adminSession: Awaited<ReturnType<BrowserContext['storageState']>>;

/** What the installer prints: the server's `agentome setup-code`, from its data directory. */
function setupCode() {
  const output = execFileSync('node', ['--import', 'tsx', 'src/cli.ts', 'setup-code'], {
    cwd: '../server',
    env: {
      ...process.env,
      AGENTOME_DATABASE_URL: process.env.AGENTOME_E2E_DATABASE_URL,
      AGENTOME_DATA_DIR: process.env.AGENTOME_E2E_DATA_DIR,
    },
  });
  return output.toString().trim();
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a clean installation: setup, sign-in, an invitation, a second person', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup code').fill(setupCode());
  await page.getByLabel('Company name').fill('Acme');
  await page.getByLabel('Your name').fill('Ann Admin');
  await page.getByLabel('Email').fill('Ann@Acme.test');
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByLabel('Confirm password').fill(adminPassword);
  await page.getByRole('button', { name: 'Create the administrator account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Ann Admin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Agentome' })).toBeVisible();

  // Sign-in returns to the page that asked for it.
  await page.goto('/admin/people');
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fpeople$/);
  await signIn(page, 'ann@acme.test', 'not the password at all');
  await expect(page.getByRole('alert')).toContainText('The email or password is wrong');
  await signIn(page, 'ann@acme.test', adminPassword);
  await expect(page).toHaveURL(/\/admin\/people$/);
  await expect(page.getByRole('cell', { name: 'ann@acme.test', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'Anyone with the link', exact: true })).toBeVisible();

  // The second person opens the link in a browser of their own.
  const theirs = await browser.newContext();
  const guest = await theirs.newPage();
  await guest.goto(link);
  await expect(guest.getByText(/invited you to join .+ as a member\./)).toBeVisible();
  await guest.getByLabel('Your name').fill('Bob Member');
  await guest.getByLabel('Email').fill('bob@acme.test');
  await guest.getByLabel('Password', { exact: true }).fill(memberPassword);
  await guest.getByRole('button', { name: 'Create account' }).click();
  await expect(guest.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Bob Member' })).toBeVisible();
  await guest.goto('/admin/people');
  await expect(guest.getByRole('heading', { name: 'Only admins can manage people' })).toBeVisible();

  // The link worked once; the admin now sees the person and no pending invitation.
  await guest.goto(link);
  await expect(
    guest.getByRole('heading', { name: 'This invitation was already used' }),
  ).toBeVisible();
  await theirs.close();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'bob@acme.test', exact: true })).toBeVisible();
  await expect(page.getByText('No pending invitations.')).toBeVisible();
  adminSession = await page.context().storageState();
});

test('an agent from a role template: instructions edited, saved and previewed', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  await page.goto('/agents');
  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  // The server seeds the role templates on its first start.
  await dialog.getByRole('radio', { name: 'Backend developer' }).check();
  await dialog.getByLabel('Name').fill('Payments backend');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Payments backend' })).toBeVisible();
  const sheet = page.getByRole('complementary', { name: /^Agent sheet/ });
  await expect(sheet.getByText('Backend developer v1')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Payments backend, EU');
  // The template's instructions open as they read; their source is on Write.
  await expect(page.getByRole('heading', { name: 'What you own' })).toBeVisible();
  await page.getByRole('tab', { name: 'Write' }).click();
  const instructions = page.getByRole('textbox', { name: 'Instructions' });
  await expect(instructions).toHaveValue(/## What you own/);
  await instructions.fill('Reproduce a bug with a failing test first, then fix it.');
  await expect(sheet.getByRole('heading', { name: 'Payments backend, EU' })).toBeVisible();
  await expect(page.getByText('2 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payments backend, EU' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

  // The preview is what a run gets: the saved name and instructions in CLAUDE.md.
  await sheet.getByRole('button', { name: 'Preview workspace' }).click();
  const preview = page.getByRole('dialog', { name: 'Preview workspace' });
  await expect(preview.getByText(/^# Payments backend, EU/)).toContainText(
    '## Instructions\n\nReproduce a bug with a failing test first, then fix it.',
  );
  await preview.getByRole('button', { name: 'Done' }).click();
  // A new agent that has not run is not in the sidebar, which lists the ones that need a look.
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByRole('link', { name: /Payments backend/ })).toHaveCount(0);
  await context.close();
});

test("a task from the agent's Run: created, run by a scripted computer, run again, done", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: adminSession });
  const page = await context.newPage();
  await page.goto('/agents');
  await page.getByRole('link', { name: 'Payments backend, EU' }).first().click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
  // Every task is filed in a project: the agent goes on one first.
  const agentId = new URL(page.url()).pathname.split('/').at(-1);
  const project = await (
    await page.request.post('/api/projects', { data: { name: 'Payments' } })
  ).json();
  const assigned = await page.request.put(`/api/projects/${project.id}/agents/${agentId}`);
  expect(assigned.status()).toBe(204);
  const sheet = page.getByRole('complementary', { name: /^Agent sheet/ });
  await sheet.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByRole('combobox', { name: /^For/ })).toContainText(
    'Payments backend, EU',
  );
  // Its only project is chosen for it.
  await expect(dialog.getByRole('combobox', { name: 'Project: Payments' })).toBeVisible();
  await dialog.getByLabel('Title').fill('Add a README to the test repository');
  await dialog.getByLabel('Description').fill('Say what the service does and how to run it.');
  // Where it works takes no path the computer can't use, and says why.
  await dialog.getByRole('button', { name: /^Where it works/ }).click();
  const where = page.getByRole('combobox', { name: 'Folder path or repository URL' });
  await where.fill('code/test-repo');
  await expect(page.getByText(/Use a URL that starts with/)).toBeVisible();
  await where.fill('https://github.com/acme/test-repo.git');
  await where.press('Enter');
  await expect(dialog.getByRole('button', { name: /^Where it works/ })).toContainText(
    'acme/test-repo.git',
  );
  await dialog.getByRole('button', { name: 'Create and run' }).click();

  // A queued run opens on its own page, which follows it live.
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = new URL(page.url()).pathname.split('/').at(-1);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Add a README to the test repository' }),
  ).toBeVisible();
  const status = page.locator('#run-status');
  await expect(status).toHaveText('Queued');

  // A computer of Ann's, scripted through the seat protocol, takes the run and finishes it.
  const code = await (await page.request.post('/api/seats/pairing-codes')).json();
  const seat = await page.request.post('/api/seats/pair', {
    data: {
      code: code.code,
      name: 'scripted-laptop',
      kind: 'subscription-laptop',
      engines: ['claude-code'],
    },
  });
  const { token } = await seat.json();
  const claim = await page.request.get('/api/seats/claim?wait=5', {
    headers: { authorization: `Bearer ${token}` },
  });
  const launch = await claim.json();
  expect(launch.run.id).toBe(runId);
  expect(launch.task).toMatchObject({
    title: 'Add a README to the test repository',
    repository: 'https://github.com/acme/test-repo.git',
  });
  const finished = await page.request.post(`/api/runs/${runId}/finish`, {
    headers: { authorization: `Bearer ${launch.run.token}` },
    data: { status: 'done', summary: 'Added README.md' },
  });
  expect(finished.status()).toBe(200);
  await expect(status).toHaveText('Done', { timeout: 15_000 });

  // The run leads to its task, which lists it and can run again.
  const about = page.getByRole('region', { name: 'Run details' });
  await about.getByRole('link', { name: 'Open the task' }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  // The task's activity: the run in words, opening its page; then the run queued again.
  const activity = page.getByRole('region', { name: 'Activity' });
  const latest = activity.getByRole('listitem').last();
  await expect(latest).toContainText('ran it · finished');
  await expect(latest.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
    'href',
    `/runs/${runId}`,
  );
  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(activity.getByText('2 runs')).toBeVisible();
  await expect(activity.getByRole('listitem').last()).toContainText(
    'will run it once a computer takes it',
  );
  await expect(page.getByRole('button', { name: 'Run again' })).toBeDisabled();
  await expect(activity.getByText('Available when the current run ends.')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await page.goto('/tasks?status=done');
  await expect(
    page.getByRole('link', { name: 'Add a README to the test repository' }),
  ).toBeVisible();
  await context.close();
});
