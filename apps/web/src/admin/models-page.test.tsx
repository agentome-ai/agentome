import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, failure, member, mockApi } from '../test-api';

const gateway = {
  id: 'mc1',
  name: 'Company LiteLLM',
  kind: 'gateway',
  baseUrl: 'https://litellm.acme.com',
  models: [
    { id: 'claude-sonnet-4-5', engine: 'claude-code' },
    { id: 'qwen3-coder', engine: 'codex' },
  ],
  checkedAt: '2026-11-01T08:40:00Z',
  createdAt: '2026-11-01T08:40:00Z',
};

function renderModels(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  render(
    <MemoryRouter initialEntries={['/admin/models']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('Admin, Models', () => {
  it('connects a gateway, the company’s LiteLLM, with its address and key, and lists its models', async () => {
    const { calls, user } = renderModels({
      'GET /api/model-connections': { connections: [] },
      'POST /api/model-connections': () => ({ status: 201, json: gateway }),
    });
    await user.click(await screen.findByRole('button', { name: 'New connection' }));
    const composer = screen.getByRole('dialog', { name: 'New model connection' });
    const connect = within(composer).getByRole('button', { name: 'Connect' });
    await user.type(within(composer).getByLabelText('Name'), 'Company LiteLLM');
    await user.type(within(composer).getByLabelText('API key'), 'sk-test');
    // A gateway has no address of its own: none given, no connection.
    expect(connect).toHaveProperty('disabled', true);
    await user.type(within(composer).getByLabelText('Address'), 'https://litellm.acme.com');
    await user.click(connect);
    expect(calls.find((call) => call.route === 'POST /api/model-connections')?.body).toEqual({
      name: 'Company LiteLLM',
      kind: 'gateway',
      key: 'sk-test',
      baseUrl: 'https://litellm.acme.com',
    });

    await user.click(await screen.findByRole('button', { name: 'Company LiteLLM, Gateway' }));
    const models = screen.getByRole('dialog', { name: 'Company LiteLLM' });
    expect(within(models).getByRole('region', { name: 'Claude Code' }).textContent).toContain(
      'claude-sonnet-4-5',
    );
    expect(within(models).getByRole('region', { name: 'Codex' }).textContent).toContain(
      'qwen3-coder',
    );
  });

  it('says what the server said when the key is refused', async () => {
    const { user } = renderModels({
      'GET /api/model-connections': { connections: [] },
      'POST /api/model-connections': failure(
        400,
        'connection_unauthorized',
        'api.anthropic.com refused the key. Check it and paste it again.',
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'New connection' }));
    const composer = screen.getByRole('dialog', { name: 'New model connection' });
    await user.click(within(composer).getByRole('combobox', { name: 'Kind: Gateway' }));
    await user.click(await screen.findByRole('option', { name: /Anthropic/ }));
    await user.type(within(composer).getByLabelText('Name'), 'Anthropic');
    await user.type(within(composer).getByLabelText('API key'), 'sk-wrong');
    await user.click(within(composer).getByRole('button', { name: 'Connect' }));
    expect((await within(composer).findByRole('alert')).textContent).toContain('refused the key');
  });

  it('tells a member that only admins manage them', async () => {
    renderModels({ 'GET /api/me': member });
    expect(
      await screen.findByRole('heading', { name: 'Only admins manage model connections' }),
    ).toBeTruthy();
  });
});
