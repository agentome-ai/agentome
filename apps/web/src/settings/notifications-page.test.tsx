import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';

// jsdom has no service worker and no Push API: each test hands the page the browser it needs.

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/settings/notifications']}>
      <App />
    </MemoryRouter>,
  );
}

const subscriptionJson = {
  endpoint: 'https://web.push.apple.com/device',
  keys: { p256dh: 'BPk', auth: 'c2VjcmV0' },
};

function browser(options: { secure?: boolean; push?: boolean; userAgent?: string } = {}) {
  const { secure = true, push = true, userAgent } = options;
  vi.stubGlobal('isSecureContext', secure);
  if (userAgent) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  if (!push) return undefined;
  let current: {
    endpoint: string;
    toJSON: () => object;
    unsubscribe: () => Promise<boolean>;
  } | null = null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = {
        endpoint: subscriptionJson.endpoint,
        toJSON: () => subscriptionJson,
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return current;
    }),
  };
  const registration = { pushManager };
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal(
    'Notification',
    Object.assign(class {}, {
      permission: 'default',
      requestPermission: vi.fn(async () => 'granted'),
    }),
  );
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  return pushManager;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('Settings, Notifications', () => {
  it('says that an address without HTTPS gets no notifications', async () => {
    browser({ secure: false });
    mockApi({ 'GET /api/me': admin });
    renderPage();
    expect(await screen.findByText(/isn't HTTPS/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('sends Safari on an iPhone to the Home Screen first', async () => {
    browser({
      push: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
    });
    mockApi({ 'GET /api/me': admin });
    renderPage();
    expect(await screen.findByText(/Add to Home Screen/)).toBeTruthy();
  });

  it('turns notifications on, sends a test and turns them off', async () => {
    const pushManager = browser();
    const calls = mockApi({
      'GET /api/me': admin,
      'GET /api/me/push': { publicKey: 'BAAB' },
      'PUT /api/me/push/subscriptions': () => ({ status: 204 }),
      'POST /api/me/push/test': { sent: 1 },
      'DELETE /api/me/push/subscriptions': () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    renderPage();

    const on = await screen.findByRole('switch', { name: 'Push notifications' });
    await vi.waitFor(() => expect(on).toHaveProperty('disabled', false));
    await user.click(on);
    await vi.waitFor(() => expect(on.getAttribute('aria-checked')).toBe('true'));
    expect(pushManager?.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([4, 0, 1]),
    });
    expect(calls.find((call) => call.route.startsWith('PUT'))?.body).toEqual(subscriptionJson);

    await user.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('Sent to this device.')).toBeTruthy();

    await user.click(on);
    await vi.waitFor(() => expect(on.getAttribute('aria-checked')).toBe('false'));
    expect(calls.find((call) => call.route.startsWith('DELETE'))?.body).toEqual({
      endpoint: subscriptionJson.endpoint,
    });
  });
});
