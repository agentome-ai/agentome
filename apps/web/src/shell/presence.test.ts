import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportPresence } from './presence';

describe('presence', () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('says the person is here at most once a minute, while they use a visible tab', () => {
    vi.useFakeTimers();
    let clock = 0;
    const send = vi.fn(async () => undefined);
    stop = reportPresence(send, () => clock);
    expect(send).toHaveBeenCalledTimes(1);

    clock = 20_000;
    window.dispatchEvent(new Event('keydown'));
    expect(send).toHaveBeenCalledTimes(1);

    clock = 61_000;
    window.dispatchEvent(new Event('pointerdown'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('says nothing for a tab that is open but not used, or hidden', () => {
    vi.useFakeTimers();
    let clock = 0;
    const send = vi.fn(async () => undefined);
    stop = reportPresence(send, () => clock);
    send.mockClear();

    clock = 125_000;
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('keydown'));
    expect(send).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});
