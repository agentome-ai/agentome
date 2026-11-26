import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { admin, failure, mockApi } from '../test-api';
import { authorizationOf } from './mcp-servers';

const skill = (id: string, name: string, owner: string, visibility: string) => ({
  id,
  name,
  description: `Writes ${name}`,
  version: 1,
  owner: { id: owner, name: owner === admin.id ? admin.name : 'Ilya' },
  visibility,
  fileCount: 0,
  fileBytes: 0,
  // A version read whole lists its files; the list leaves them out, and nothing reads them there.
  files: [] as { path: string; size: number }[],
  createdAt: new Date().toISOString(),
});

/** The names of the library's list under a heading, in order. */
const listed = (label: string) =>
  within(screen.getByRole(label === 'MCP servers' ? 'list' : 'region', { name: label }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);
const pane = async (name: string) => within(await screen.findByRole('article', { name }));
const menuOf = async (user: ReturnType<typeof userEvent.setup>, name: string, item: string) => {
  await user.click(await screen.findByRole('button', { name: `More actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

function renderLibrary(routes: Parameters<typeof mockApi>[0], at = '/skills') {
  const calls = mockApi({
    'GET /api/me': admin,
    'GET /api/library/mcp': { servers: [] },
    ...routes,
  });
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <App /> }], {
        initialEntries: [at],
      })}
    />,
  );
  return { calls, user: userEvent.setup() };
}

describe('the skills', () => {
  it('lists the skills by whose they are and shows the first one whole', async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const shipped = { ...skill('s3', 'frontend-design', 'u9', 'org'), owner: null };
    renderLibrary({
      'GET /api/library/skills': {
        skills: [skill('s2', 'release-notes', 'u9', 'org'), shipped, mine],
      },
      'GET /api/library/skills/s1': {
        ...mine,
        content: '---\nname: payments-fixtures\n---\n\n# Fixtures\n\nBuild them from an export.',
      },
    });
    const shown = await pane('payments-fixtures');
    expect(await shown.findByRole('heading', { level: 2, name: 'payments-fixtures' })).toBeTruthy();
    expect(listed('Yours: skills')).toEqual(['payments-fixturesWrites payments-fixtures']);
    expect(listed('Shared by others: skills')).toEqual(['release-notesWrites release-notes']);
    expect(listed('From Agentome: skills')).toEqual(['frontend-designWrites frontend-design']);
    // The picked one is marked in the list, and read without its frontmatter.
    expect(
      screen.getByRole('button', { name: /^payments-fixtures/ }).getAttribute('aria-current'),
    ).toBe('true');
    expect(await shown.findByRole('heading', { name: 'Fixtures' })).toBeTruthy();
    expect(shown.queryByText(/name: payments-fixtures/)).toBeNull();
    expect(shown.getByText('only its author')).toBeTruthy();
    expect(shown.getByText(/ago by you|just now by you/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("edits the author's skill into a new version, and offers no Edit on someone else's", async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const theirs = skill('s2', 'release-notes', 'u9', 'org');
    const source = '---\nname: payments-fixtures\n---\n\n# Fixtures\n';
    // Once the version is saved, the list names it in the place of the one before.
    let saved = false;
    const next = { ...mine, id: 's9', version: 2 };
    const { calls, user } = renderLibrary({
      'GET /api/library/skills': () => ({ json: { skills: [saved ? next : mine, theirs] } }),
      'GET /api/library/skills/s1': { ...mine, content: source },
      'GET /api/library/skills/s2': { ...theirs, content: '---\nname: release-notes\n---\n' },
      'GET /api/library/skills/s9': { ...next, content: `${source}More.` },
      'POST /api/library/skills/s1/versions': () => {
        saved = true;
        return { json: { ...next, content: '' } };
      },
    });
    await user.click(
      await (await pane('payments-fixtures')).findByRole('button', { name: 'Edit' }),
    );
    const field = (await pane('payments-fixtures')).getByRole('textbox', { name: 'SKILL.md' });
    expect(field).toHaveProperty('value', source);
    await user.type(field, 'More.');
    await user.click(screen.getByRole('button', { name: 'Save as a new version' }));
    expect(
      calls.find((call) => call.route === 'POST /api/library/skills/s1/versions')?.body,
    ).toEqual({ content: `${source}More.` });
    // The new version is the one shown now.
    expect(await screen.findByRole('article', { name: 'payments-fixtures' })).toBeTruthy();
    expect(await screen.findByText('2')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^release-notes/ }));
    expect(await (await pane('release-notes')).findByText(/by Ilya/)).toBeTruthy();
    expect((await pane('release-notes')).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('lets an admin share a private skill with everyone', async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const { calls, user } = renderLibrary({
      'GET /api/library/skills': { skills: [mine] },
      'GET /api/library/skills/s1': { ...mine, content: '---\nname: payments-fixtures\n---\n' },
      'POST /api/library/skills/s1/share': { ...mine, visibility: 'org', content: '' },
    });
    await menuOf(user, 'payments-fixtures', 'Share with everyone');
    expect(calls.some((call) => call.route === 'POST /api/library/skills/s1/share')).toBe(true);
  });

  it('adds a skill from a pasted SKILL.md, and says what the server refused', async () => {
    const { calls, user } = renderLibrary({
      'GET /api/library/skills': { skills: [] },
      'POST /api/library/skills': () => ({
        status: 400,
        json: {
          error: {
            code: 'validation_failed',
            message: 'Give the skill a description in its frontmatter',
          },
        },
      }),
    });
    expect(await screen.findByText(/No skills yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a skill' }));
    const form = await pane('Add a skill');
    await user.click(form.getByRole('button', { name: 'Add skill' }));
    expect(calls.find((call) => call.route === 'POST /api/library/skills')?.body).toMatchObject({
      content: expect.stringContaining('name: release-notes'),
    });
    expect(await form.findByText('Give the skill a description in its frontmatter')).toBeTruthy();
  });

  it('adds a skill from its folder: its SKILL.md, the files beside it, hidden ones left out', async () => {
    const text = '---\nname: sr-docs\ndescription: A vendor docs\n---\n\nRead references/.';
    const added = {
      ...skill('s5', 'sr-docs', admin.id, 'private'),
      fileCount: 1,
      fileBytes: 3,
      content: text,
      files: [{ path: 'references/a.md', size: 3 }],
    };
    let posted = false;
    const { calls, user } = renderLibrary({
      'GET /api/library/skills': () => ({ json: { skills: posted ? [added] : [] } }),
      'POST /api/library/skills': () => {
        posted = true;
        return { json: added };
      },
      'GET /api/library/skills/s5': added,
    });
    const inFolder = (path: string, content: string) => {
      const file = new File([content], path.split('/').pop() ?? path);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    };
    await user.click(await screen.findByRole('button', { name: 'Add a skill' }));
    const form = await pane('Add a skill');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('No folder input');
    await user.upload(input, [
      inFolder('sr-docs/SKILL.md', text),
      inFolder('sr-docs/references/a.md', 'abc'),
      inFolder('sr-docs/.git/config', 'x'),
    ]);
    expect(
      await form.findByText('1 file, 3 bytes and its SKILL.md; 1 hidden left out.'),
    ).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Add skill' }));
    expect(calls.find((call) => call.route === 'POST /api/library/skills')?.body).toEqual({
      content: text,
      files: [{ path: 'references/a.md', content: btoa('abc') }],
    });
    const shown = await pane('sr-docs');
    expect(
      // The files come with the version read whole, after the pane opens.
      within(await shown.findByRole('list', { name: 'Files of the skill' })).getByText(
        'references/a.md',
      ),
    ).toBeTruthy();
  });

  it('refuses a folder whose files a skill cannot take, before sending anything', async () => {
    const { calls, user } = renderLibrary({ 'GET /api/library/skills': { skills: [] } });
    await user.click(await screen.findByRole('button', { name: 'Add a skill' }));
    const form = await pane('Add a skill');
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'spec.json');
    Object.defineProperty(big, 'webkitRelativePath', { value: 'sr/spec.json' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('No folder input');
    await user.upload(input, [big]);
    expect(
      await form.findByText('spec.json is 5.0 MB. A file of a skill may be 5 MB at most.'),
    ).toBeTruthy();
    expect(calls.some((call) => call.route === 'POST /api/library/skills')).toBe(false);
  });

  it('says which of the person’s agents have the skill', async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const theirs = skill('s2', 'release-notes', 'u9', 'org');
    const { user } = renderLibrary({
      'GET /api/library/skills': { skills: [mine, theirs] },
      'GET /api/library/skills/s1': { ...mine, content: '---\nname: payments-fixtures\n---\n' },
      'GET /api/library/skills/s2': { ...theirs, content: '---\nname: release-notes\n---\n' },
      'GET /api/library/skills/s1/agents': {
        agents: [{ id: 'a1', name: 'Payments backend' }],
      },
      'GET /api/library/skills/s2/agents': { agents: [] },
    });
    const about = await pane('payments-fixtures');
    expect(about.getByText('Used by')).toBeTruthy();
    expect(
      (await about.findByRole('link', { name: 'Payments backend' })).getAttribute('href'),
    ).toBe('/agents/a1');
    await user.click(screen.getByRole('button', { name: /^release-notes/ }));
    expect(await (await pane('release-notes')).findByText('None of your agents')).toBeTruthy();
  });

  it('opens the skill its address names, from an old Library link too', async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const theirs = skill('s2', 'release-notes', 'u9', 'org');
    renderLibrary(
      {
        'GET /api/library/skills': { skills: [mine, theirs] },
        'GET /api/library/skills/s2': { ...theirs, content: '---\nname: release-notes\n---\n' },
      },
      '/library?skill=s2',
    );
    expect(await (await pane('release-notes')).findByText('Version')).toBeTruthy();
  });
});

describe('deleting a skill', () => {
  it("deletes the author's skill after asking, and offers no Delete on one Agentome ships", async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const shipped = { ...skill('s3', 'frontend-design', 'u9', 'org'), owner: null };
    const { calls, user } = renderLibrary({
      'GET /api/library/skills': { skills: [mine, shipped] },
      'GET /api/library/skills/s1': { ...mine, content: '---\nname: payments-fixtures\n---\n' },
      'GET /api/library/skills/s3': { ...shipped, content: '---\nname: frontend-design\n---\n' },
      'DELETE /api/library/skills/s1': () => ({ status: 204 }),
    });
    await user.click(await screen.findByRole('button', { name: /^frontend-design/ }));
    expect(await (await pane('frontend-design')).findByText(/by Agentome/)).toBeTruthy();
    // Nothing can be done to a skill Agentome ships: no Edit and no menu.
    expect(
      (await pane('frontend-design')).queryAllByRole('button', { name: /Edit|More actions/ }),
    ).toEqual([]);

    await user.click(screen.getByRole('button', { name: /^payments-fixtures/ }));
    await menuOf(user, 'payments-fixtures', 'Delete');
    let dialog = await screen.findByRole('dialog');
    // Cancel goes back to the skill; nothing is deleted until the second click.
    expect(within(dialog).getByText(/Every version goes/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.route === 'DELETE /api/library/skills/s1')).toBe(false);
    await menuOf(user, 'payments-fixtures', 'Delete');
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete skill' }));
    expect(calls.some((call) => call.route === 'DELETE /api/library/skills/s1')).toBe(true);
  });
});

describe('the MCP servers', () => {
  const tracker = {
    id: 'm1',
    name: 'tracker',
    description: 'Our issue tracker',
    url: 'https://mcp.acme.com/mcp',
    hasAuthorization: true,
    tools: [{ name: 'create_issue', title: 'Create an issue', description: 'Files an issue' }],
    checkedAt: new Date().toISOString(),
    owner: { id: admin.id, name: admin.name },
    visibility: 'private',
  };

  const renderServers = (routes: Parameters<typeof mockApi>[0], at = '/mcp-servers') =>
    renderLibrary(routes, at);

  it('adds a server with its secret, then shows its tools without the secret', async () => {
    const { calls, user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker] },
      'POST /api/library/mcp': tracker,
      'POST /api/library/mcp/m1/share': { ...tracker, visibility: 'org' },
    });
    await user.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    const add = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await user.type(within(add).getByLabelText('Name'), 'tracker');
    await user.type(within(add).getByLabelText('Address'), 'https://mcp.acme.com/mcp');
    // Bearer stands before the field: the token alone is pasted.
    await user.type(within(add).getByLabelText('Token'), 's3cret');
    await user.click(within(add).getByRole('button', { name: 'Add server' }));
    expect(calls.find((call) => call.route === 'POST /api/library/mcp')?.body).toEqual({
      name: 'tracker',
      url: 'https://mcp.acme.com/mcp',
      description: '',
      auth: 'header',
      authorization: 'Bearer s3cret',
    });
    expect(listed('MCP servers')).toEqual(['tracker1 tool']);
    const shown = await pane('tracker');
    expect(shown.getByText('A token, kept on Agentome')).toBeTruthy();
    expect(shown.getByText('Create an issue')).toBeTruthy();
    await menuOf(user, 'tracker', 'Share with everyone');
    expect(calls.some((call) => call.route === 'POST /api/library/mcp/m1/share')).toBe(true);
  });

  it("edits the author's server: its address, what it does and a new token", async () => {
    const { calls, user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker] },
      'PATCH /api/library/mcp/m1': { ...tracker, url: 'https://mcp.acme.com/v2/mcp' },
    });
    await user.click(await (await pane('tracker')).findByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit tracker' });
    const address = within(edit).getByLabelText('Address');
    expect(address).toHaveProperty('value', 'https://mcp.acme.com/mcp');
    await user.clear(address);
    await user.type(address, 'https://mcp.acme.com/v2/mcp');
    // An empty token keeps the one the server has: nothing is sent for it.
    expect(within(edit).getByText(/Leave it empty to keep the token/)).toBeTruthy();
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(calls.find((call) => call.route === 'PATCH /api/library/mcp/m1')?.body).toEqual({
      url: 'https://mcp.acme.com/v2/mcp',
      description: 'Our issue tracker',
    });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("offers no Edit on someone else's server, and says what the server refused of an edit", async () => {
    const theirs = { ...tracker, id: 'm3', name: 'metrics', owner: { id: 'u9', name: 'Ilya' } };
    const { user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker, theirs] },
      'PATCH /api/library/mcp/m1': failure(400, 'validation_failed', 'The request is not valid', [
        { path: 'body/url', message: 'Use an https address' },
      ]),
    });
    await user.click(await (await pane('tracker')).findByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit tracker' });
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(await within(edit).findByText('Use an https address')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^metrics/ }));
    expect((await pane('metrics')).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('deletes a server after asking', async () => {
    const { calls, user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker] },
      'DELETE /api/library/mcp/m1': () => ({ status: 204 }),
    });
    await menuOf(user, 'tracker', 'Delete');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/its token is deleted too/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete server' }));
    expect(calls.some((call) => call.route === 'DELETE /api/library/mcp/m1')).toBe(true);
  });

  it('adds a server that signs in with OAuth and opens its sign-in', async () => {
    const jira = { ...tracker, id: 'm2', name: 'jira', auth: 'oauth', signedIn: false, tools: [] };
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { calls, user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker] },
      'POST /api/library/mcp': jira,
      'POST /api/library/mcp/m2/sign-in': { url: 'https://sso.acme.com/authorize?state=x' },
    });
    await user.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    const add = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await user.type(within(add).getByLabelText('Name'), 'jira');
    await user.type(within(add).getByLabelText('Address'), 'https://llm.acme.com/jira/mcp');
    await user.click(within(add).getByRole('combobox', { name: 'Sign-in' }));
    await user.click(await screen.findByRole('option', { name: 'OAuth in the browser' }));
    // No token for a server each person signs in to.
    expect(within(add).queryByLabelText('Token')).toBeNull();
    await user.click(within(add).getByRole('button', { name: 'Add and sign in' }));
    expect(calls.find((call) => call.route === 'POST /api/library/mcp')?.body).toMatchObject({
      name: 'jira',
      auth: 'oauth',
    });
    expect(calls.find((call) => call.route === 'POST /api/library/mcp')?.body).not.toHaveProperty(
      'authorization',
    );
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://sso.acme.com/authorize?state=x'),
    );
    vi.unstubAllGlobals();
  });

  it('says how the sign-in the browser came back from went, and offers Sign in to who has none', async () => {
    const jira = { ...tracker, id: 'm2', name: 'jira', auth: 'oauth', signedIn: false, tools: [] };
    renderServers(
      { 'GET /api/library/skills': { skills: [] }, 'GET /api/library/mcp': { servers: [jira] } },
      '/mcp-servers?mcpError=The+sign-in+was+cancelled',
    );
    expect(await screen.findByText(/Couldn't sign in: The sign-in was cancelled/)).toBeTruthy();
    expect(listed('MCP servers')).toEqual(['jiraNot signed in']);
    const shown = await pane('jira');
    expect(shown.getByText('OAuth, not signed in')).toBeTruthy();
    expect(shown.getByText('Listed after you sign in.')).toBeTruthy();
    expect(shown.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    // Nothing to check before a sign-in: the menu has only what its author may do.
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for jira' }));
    expect(screen.queryByRole('menuitem', { name: 'Check again' })).toBeNull();
  });

  it('opens the server the browser has just signed in to, from the old return address too', async () => {
    const jira = { ...tracker, id: 'm2', name: 'jira', auth: 'oauth', signedIn: true };
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    renderServers(
      {
        'GET /api/library/skills': { skills: [mine] },
        'GET /api/library/mcp': { servers: [tracker, jira] },
      },
      '/library?mcpSignedIn=jira',
    );
    const shown = await pane('jira');
    expect(await shown.findByRole('status')).toHaveProperty(
      'textContent',
      'Signed in to jira. Your agents that have it can use its tools.',
    );
    expect(shown.getByText('OAuth, as you')).toBeTruthy();
  });

  it('filters a long list of skills', async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      skill(`s${i}`, i === 4 ? 'release-notes' : `skill-${i}`, admin.id, 'private'),
    );
    const { user } = renderLibrary({
      'GET /api/library/skills': { skills: many },
      'GET /api/library/skills/s0': { ...many[0], content: '---\nname: skill-0\n---\n' },
      'GET /api/library/skills/s0/agents': { agents: [] },
    });
    const filter = await screen.findByRole('searchbox', { name: 'Filter skills' });
    expect(screen.getByText('9 skills')).toBeTruthy();
    await user.type(filter, 'release');
    expect(listed('Yours: skills')).toEqual(['release-notesWrites release-notes']);
    await user.clear(filter);
    await user.type(filter, 'nothing like it');
    expect(
      screen.getByText('No skill has “nothing like it” in its name or description.'),
    ).toBeTruthy();
  });

  it('lists a server’s tools a line each, whole on a click, and filters a long list', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: i === 3 ? 'close_issue' : `tool_${i}`,
      title: i === 3 ? 'Close an issue' : `Tool ${i}`,
      description: i === 3 ? 'Closes an issue with a resolution and a comment' : '',
    }));
    const { user } = renderServers({
      'GET /api/library/mcp': { servers: [{ ...tracker, tools: many }] },
      'GET /api/library/mcp/m1/agents': { agents: [] },
    });
    const shown = await pane('tracker');
    const close = shown.getByRole('button', { name: /Close an issue/ });
    expect(close.getAttribute('aria-expanded')).toBe('false');
    await user.click(close);
    expect(close.getAttribute('aria-expanded')).toBe('true');
    // A tool with nothing more to say does not open.
    expect(shown.getByRole('button', { name: /Tool 0/ })).toHaveProperty('disabled', true);
    await user.type(shown.getByRole('searchbox', { name: 'Filter tools' }), 'resolution');
    expect(
      within(shown.getByRole('list', { name: 'Tools' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('says what the page is for when it has no servers, and opens Add an MCP server', async () => {
    const { user } = renderServers({ 'GET /api/library/mcp': { servers: [] } });
    expect(await screen.findByText(/No MCP servers yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add an MCP server' }));
    expect(screen.getByRole('dialog', { name: 'Add an MCP server' })).toBeTruthy();
  });

  it('has Skills and MCP servers in the sidebar, not the Library', async () => {
    renderServers({ 'GET /api/library/mcp': { servers: [tracker] } });
    const sidebar = await screen.findByRole('link', { name: 'MCP servers' });
    expect(sidebar.getAttribute('href')).toBe('/mcp-servers');
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('href')).toBe('/skills');
    expect(screen.queryByRole('link', { name: 'Library' })).toBeNull();
  });

  it('names the field the server refuses, under that field', async () => {
    const { user } = renderServers({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [tracker] },
      'POST /api/library/mcp': failure(400, 'validation_failed', 'The request is not valid', [
        { path: 'body/name', message: 'Use lowercase letters, digits and hyphens, such as jira' },
      ]),
    });
    await user.click(await screen.findByRole('button', { name: 'Add an MCP server' }));
    const add = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await user.type(within(add).getByLabelText('Name'), 'Jira DC');
    await user.type(within(add).getByLabelText('Address'), 'https://mcp.acme.com/mcp');
    await user.click(within(add).getByRole('button', { name: 'Add server' }));
    const name = within(add).getByLabelText('Name');
    expect(await within(add).findByText(/Use lowercase letters/)).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(add).queryByText('The request is not valid')).toBeNull();
  });
});

describe('the token of an MCP server', () => {
  it('becomes a Bearer header, and a whole header stays as typed', () => {
    expect(authorizationOf('  s3cret ')).toBe('Bearer s3cret');
    expect(authorizationOf('Bearer s3cret')).toBe('Bearer s3cret');
    expect(authorizationOf('Basic dXNlcjpwYXNz')).toBe('Basic dXNlcjpwYXNz');
    expect(authorizationOf('   ')).toBeUndefined();
  });
});
