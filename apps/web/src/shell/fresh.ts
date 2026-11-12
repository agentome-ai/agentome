import type { createBrowserRouter } from 'react-router';

// An app kept open never loads index.html again, so it runs the version it started with for
// days: the home-screen app on a phone above all, which the phone keeps in memory. It asks for
// index.html when it comes back into view and on its own navigations, and loads the new
// version if index.html names another script than the one it runs. The home-screen app reloads
// as it comes back; a browser tab waits for its next navigation, which the agent editor already
// holds while edits are unsaved, so no edit is lost.

type Router = ReturnType<typeof createBrowserRouter>;

/** At most this often on navigations: a person clicking around asks once. */
const EVERY_MS = 60_000;

const scriptOf = (html: string) =>
  /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1] ?? null;

/** True when the server has another version than the page runs. */
export async function isStale(running: string, fetchFn: typeof fetch = fetch) {
  try {
    const response = await fetchFn('/', { headers: { accept: 'text/html' }, cache: 'no-cache' });
    if (!response.ok) return false;
    const latest = scriptOf(await response.text());
    return latest !== null && latest !== running;
  } catch {
    // Offline or the server restarting: the next look decides.
    return false;
  }
}

export function loadNewVersions(router: Router) {
  const running = document
    .querySelector<HTMLScriptElement>('script[type="module"][src]')
    ?.getAttribute('src');
  // The dev server has no built index.html to compare with.
  if (!running || import.meta.env.DEV) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  let stale = false;
  let lastLook = Date.now();
  const look = async () => {
    lastLook = Date.now();
    stale ||= await isStale(running);
    return stale;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void look().then((found) => found && standalone && window.location.reload());
  });
  let path = router.state.location.pathname;
  router.subscribe((state) => {
    if (state.navigation.state !== 'idle' || state.location.pathname === path) return;
    path = state.location.pathname;
    // The page the person went to, loaded afresh: they asked for a new page anyway.
    if (stale) window.location.reload();
    else if (Date.now() - lastLook > EVERY_MS) void look();
  });
}
