import { useEffect } from 'react';

// How far a finger pulls down from the top of a page, after the drag's resistance, to reload.
const THRESHOLD = 64;

/**
 * A phone's pull to refresh. The page does not bounce past its top, so the
 * PWA had no way to reload: pulled down from the top past the threshold, the page reloads.
 * Nothing is drawn for it. Never from inside a dialog, a menu or a field.
 */
export function PullToRefresh() {
  useEffect(() => {
    let start: number | null = null;
    let distance = 0;
    const onStart = (event: TouchEvent) => {
      const target = event.target;
      const taken =
        target instanceof Element &&
        target.closest('[role=dialog], [role=menu], [role=listbox], input, textarea') !== null;
      start =
        window.scrollY > 0 || event.touches.length !== 1 || taken
          ? null
          : (event.touches[0]?.clientY ?? null);
    };
    const onMove = (event: TouchEvent) => {
      if (start === null) return;
      const moved = (event.touches[0]?.clientY ?? start) - start;
      distance = moved > 0 && window.scrollY <= 0 ? moved * 0.5 : 0;
    };
    const onEnd = () => {
      if (start === null) return;
      start = null;
      if (distance >= THRESHOLD) window.location.reload();
      distance = 0;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);
  return null;
}
