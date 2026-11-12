// The phone's splash (index.html) stays at least this long from the page's start, so the first
// screen under it has loaded, then fades out.
const SHOWN_MS = 2000;
const FADE_MS = 200;

let hiding = false;

/** Lets the splash go: called once the first screen can show, the session's or a sign-in page. */
export function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash || hiding) return;
  hiding = true;
  if (!document.documentElement.classList.contains('splash')) {
    splash.remove();
    return;
  }
  const fade = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS;
  setTimeout(
    () => {
      splash.dataset.leaving = '';
      setTimeout(() => splash.remove(), fade);
    },
    Math.max(0, SHOWN_MS - performance.now()),
  );
}
