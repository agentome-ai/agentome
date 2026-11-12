import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, answer, mockApi } from '../test-api';
import { buildLabel, isNewer, RELEASES } from './version';

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/agentome-ai/agentome/releases/tag/${tag}`,
});

function renderAdmin(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <App />
    </MemoryRouter>,
  );
  return calls;
}

describe('the version in Admin', () => {
  it('says a newer release is out, where to read about it and how to update', async () => {
    const calls = renderAdmin({
      'GET /api/admin/version': { version: '0.1.0', commit: '572776f9f932', updateCheck: true },
      [`GET ${RELEASES}`]: release('v0.2.0'),
    });
    const line = (await screen.findByText('Agentome 0.2.0 is out.')).closest('p');
    expect(line?.textContent).toBe(
      'Agentome 0.2.0 is out. You run 0.1.0. What’s new, how to update.',
    );
    expect(screen.getByRole('link', { name: 'What’s new' }).getAttribute('href')).toBe(
      'https://github.com/agentome-ai/agentome/releases/tag/v0.2.0',
    );
    expect(screen.getByText('Agentome 0.1.0, build 572776f')).toBeTruthy();
    expect(screen.getByRole('link', { name: '0.2.0 is out' })).toBeTruthy();

    // Asked once a day: the next visit reads the answer it kept.
    cleanup();
    const again = renderAdmin({
      'GET /api/admin/version': { version: '0.1.0', commit: '572776f', updateCheck: true },
    });
    expect(await screen.findByText('Agentome 0.2.0 is out.')).toBeTruthy();
    expect(calls.filter((call) => call.route === `GET ${RELEASES}`)).toHaveLength(1);
    expect(again.map((call) => call.route)).not.toContain(`GET ${RELEASES}`);
  });

  it('says it is up to date when the latest release is the one it runs', async () => {
    renderAdmin({
      'GET /api/admin/version': { version: '0.2.0', commit: null, updateCheck: true },
      [`GET ${RELEASES}`]: release('v0.2.0'),
    });
    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.getByText('Agentome 0.2.0')).toBeTruthy();
    expect(screen.queryByText(/is out/)).toBeNull();
  });

  it('asks nobody when the check is off, or for a development build', async () => {
    const off = renderAdmin({
      'GET /api/admin/version': { version: '0.1.0', commit: '572776f', updateCheck: false },
    });
    expect(await screen.findByText('Agentome 0.1.0, build 572776f')).toBeTruthy();
    cleanup();
    const dev = renderAdmin({
      'GET /api/admin/version': { version: null, commit: '572776f', updateCheck: true },
    });
    expect(await screen.findByText('Development build 572776f')).toBeTruthy();
    for (const calls of [off, dev]) {
      expect(calls.map((call) => call.route)).not.toContain(`GET ${RELEASES}`);
    }
    expect(screen.queryByText('Up to date')).toBeNull();
  });

  it('says nothing of releases when GitHub has none or cannot be reached', async () => {
    renderAdmin({
      'GET /api/admin/version': { version: '0.1.0', commit: null, updateCheck: true },
      [`GET ${RELEASES}`]: answer(404, { message: 'Not Found' }),
    });
    expect(await screen.findByText('Agentome 0.1.0')).toBeTruthy();
    expect(screen.queryByText(/is out/)).toBeNull();
    expect(screen.queryByText('Up to date')).toBeNull();
  });
});

describe('versions', () => {
  it('compare as numbers, and anything else is never newer', () => {
    expect(isNewer('v0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('v1.0.0', '1.0.1')).toBe(false);
    expect(isNewer('v1.0.0-rc.1', '0.9.0')).toBe(false);
    expect(buildLabel({ version: null, commit: null })).toBe('Development build');
  });
});
