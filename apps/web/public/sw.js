/* global self, URL */
// The app's service worker: it shows the server's pushes and opens their page. It
// caches nothing, since the app is of no use without its server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const message = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(message.title ?? 'Agentome', {
      body: message.body ?? '',
      icon: '/icon-192.png',
      data: { url: message.url ?? '/' },
    }),
  );
});

// To the page of the notification: in a window of the app already open, or in a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window' });
      const open = windows.find((client) => 'navigate' in client);
      if (open) {
        await open.focus();
        if (await open.navigate(url).catch(() => null)) return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
