import { api } from '../api';

// This browser's side of web push: whether it can get notifications, and turning
// them on and off with the server. The service worker that shows them is public/sw.js.

export type PushState =
  /** Off https the browser has no service worker, so no push. */
  | 'insecure'
  /** Safari on iPhone and iPad: only the app added to the Home Screen gets pushes. */
  | 'install'
  | 'unsupported'
  | 'denied'
  | 'off'
  | 'on';

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  Reflect.get(navigator, 'standalone') === true;
// iPadOS asks for the desktop site, so it says Macintosh; only it has a touch screen.
const apple = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const subscription = async () =>
  (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() ?? null;

export async function pushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'insecure';
  if (!supported()) return apple() && !standalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await subscription()) ? 'on' : 'off';
}

/** Asks for permission and subscribes this browser; must run from a tap or a click. */
export async function turnOn(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/api/me/push');
  // One made with an earlier server key would make subscribe throw.
  await (await registration.pushManager.getSubscription())?.unsubscribe();
  const made = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64url(publicKey),
  });
  await api('/api/me/push/subscriptions', { method: 'PUT', body: made.toJSON() });
  return 'on';
}

export async function turnOff(): Promise<PushState> {
  const current = await subscription();
  if (current) {
    await api('/api/me/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: current.endpoint },
    });
    await current.unsubscribe();
  }
  return 'off';
}

/**
 * Before signing out: the next person on this browser must not get this one's notifications.
 * A browser that cannot push has nothing to forget, and a failure must not keep anyone in.
 */
export async function forgetDevice(): Promise<void> {
  if (!window.isSecureContext || !supported()) return;
  await turnOff().catch(() => undefined);
}

function base64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
