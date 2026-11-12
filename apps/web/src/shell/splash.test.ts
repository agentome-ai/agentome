import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('hideSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = '<div id="splash"></div>';
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('splash');
  });

  it('keeps a shown splash two seconds from the start, then fades it out', async () => {
    document.documentElement.classList.add('splash');
    vi.spyOn(performance, 'now').mockReturnValue(500);
    const { hideSplash } = await import('./splash');
    hideSplash();
    const splash = document.getElementById('splash');
    vi.advanceTimersByTime(1499);
    expect(splash?.dataset.leaving).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(splash?.dataset.leaving).toBe('');
    vi.advanceTimersByTime(200);
    expect(document.getElementById('splash')).toBeNull();
  });

  it('removes a splash that was never shown at once', async () => {
    const { hideSplash } = await import('./splash');
    hideSplash();
    expect(document.getElementById('splash')).toBeNull();
  });
});
