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

function renderLibrary(routes: Parameters<typeof mockApi>[0], at = '/library') {
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

describe('the library', () => {
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
    expect(shown.getByText(/Version 1, added .* by you\. Only its author can use it/)).toBeTruthy();
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
    expect(await screen.findByText(/Version 2, added/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^release-notes/ }));
    (await pane('release-notes')).findByText(/Version 1, added .* by Ilya/);
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

  it('says which of the person’s agents have the item, and where to give it to one', async () => {
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
    const about = within(
      await screen.findByRole('complementary', { name: 'About payments-fixtures' }),
    );
    expect(about.getByRole('heading', { name: 'Used by' })).toBeTruthy();
    expect(
      (await about.findByRole('link', { name: 'Payments backend' })).getAttribute('href'),
    ).toBe('/agents/a1');
    await user.click(screen.getByRole('button', { name: /^release-notes/ }));
    const none = within(await screen.findByRole('complementary', { name: 'About release-notes' }));
    expect(
      await none.findByText('None of your agents yet. Give it to one from its Skills section.'),
    ).toBeTruthy();
  });

  it('opens the skill its address names', async () => {
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    const theirs = skill('s2', 'release-notes', 'u9', 'org');
    renderLibrary(
      {
        'GET /api/library/skills': { skills: [mine, theirs] },
        'GET /api/library/skills/s2': { ...theirs, content: '---\nname: release-notes\n---\n' },
      },
      '/library?skill=s2',
    );
    expect((await pane('release-notes')).findByText(/Version 1, added/)).toBeTruthy();
  });
});

describe('deleting from the library', () => {
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
    (await pane('frontend-design')).findByText(/Version 1, added .* by Agentome/);
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

describe('the MCP servers of the library', () => {
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

  it('adds a server with its secret, then shows its tools without the secret', async () => {
    const { calls, user } = renderLibrary({
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
    expect(shown.getByText(/kept on Agentome, never shown/)).toBeTruthy();
    expect(shown.getByText('Create an issue')).toBeTruthy();
    await menuOf(user, 'tracker', 'Share with everyone');
    expect(calls.some((call) => call.route === 'POST /api/library/mcp/m1/share')).toBe(true);
  });

  it("edits the author's server: its address, what it does and a new token", async () => {
    const { calls, user } = renderLibrary({
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
    const { user } = renderLibrary({
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
    const { calls, user } = renderLibrary({
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
    const { calls, user } = renderLibrary({
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
    renderLibrary(
      { 'GET /api/library/skills': { skills: [] }, 'GET /api/library/mcp': { servers: [jira] } },
      '/library?mcpError=The+sign-in+was+cancelled',
    );
    expect(await screen.findByText(/Couldn't sign in: The sign-in was cancelled/)).toBeTruthy();
    expect(listed('MCP servers')).toEqual(['jiraNot signed in']);
    const shown = await pane('jira');
    expect(shown.getByText(/You are not signed in/)).toBeTruthy();
    expect(shown.getByText('Listed after you sign in.')).toBeTruthy();
    expect(shown.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    // Nothing to check before a sign-in: the menu has only what its author may do.
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for jira' }));
    expect(screen.queryByRole('menuitem', { name: 'Check again' })).toBeNull();
  });

  it('opens the server the browser has just signed in to, and says so once', async () => {
    const jira = { ...tracker, id: 'm2', name: 'jira', auth: 'oauth', signedIn: true };
    const mine = skill('s1', 'payments-fixtures', admin.id, 'private');
    renderLibrary(
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
    expect(shown.getByText(/You are signed in; your agents use your account/)).toBeTruthy();
  });

  it('opens Add an MCP server when the list is empty', async () => {
    const { user } = renderLibrary({
      'GET /api/library/skills': { skills: [] },
      'GET /api/library/mcp': { servers: [] },
    });
    expect(await screen.findByText(/No MCP servers yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add an MCP server' }));
    expect(screen.getByRole('dialog', { name: 'Add an MCP server' })).toBeTruthy();
  });

  it('names the field the server refuses, under that field', async () => {
    const { user } = renderLibrary({
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
