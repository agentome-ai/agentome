import { api } from '../api';

// The person's place on the company's server runs their subscription only while they are at
// work. The web app is how the server knows: once a minute, while this tab is visible and the
// person has done something in it in the last minute, it says so. An open tab nobody uses
// says nothing, and the place stops taking runs after the person's idle time.

const EVERY_MS = 60_000;
const INPUT = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'] as const;

/** Starts telling the server the person is here; the function it returns stops it. */
export function reportPresence(
  send: () => Promise<unknown> = () => api('/api/me/presence', { method: 'POST' }),
  now: () => number = Date.now,
): () => void {
  let lastInput = now();
  let lastSent = Number.NEGATIVE_INFINITY;
  const report = () => {
    const active = document.visibilityState === 'visible' && now() - lastInput < EVERY_MS;
    if (!active || now() - lastSent < EVERY_MS) return;
    lastSent = now();
    // A failed beat is the next minute's to make up: nothing to show the person.
    send().catch(() => undefined);
  };
  const onInput = () => {
    lastInput = now();
    report();
  };
  for (const name of INPUT) window.addEventListener(name, onInput, { passive: true });
  document.addEventListener('visibilitychange', report);
  const timer = window.setInterval(report, EVERY_MS / 4);
  report();
  return () => {
    for (const name of INPUT) window.removeEventListener(name, onInput);
    document.removeEventListener('visibilitychange', report);
    window.clearInterval(timer);
  };
}
