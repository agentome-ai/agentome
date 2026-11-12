import { describe, expect, it } from 'vitest';

import { fromIoreg, fromLoginctl, fromDigits } from './presence.js';

describe('the idle time', () => {
  it('is read from ioreg in nanoseconds', () => {
    const output =
      '+-o IOHIDSystem  <class IOHIDSystem>\n    {\n      "HIDIdleTime" = 14784115417250\n    }\n';
    expect(fromIoreg(output)).toBe(14_784_115);
    expect(fromIoreg('')).toBeUndefined();
  });

  it('is read from xprintidle in milliseconds', () => {
    expect(fromDigits('93000\n')).toBe(93_000);
    expect(fromDigits("Couldn't open display")).toBeUndefined();
    expect(fromDigits(undefined)).toBeUndefined();
  });

  it('is read from the idle hint of loginctl', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const since = (now - 20 * 60_000) * 1000;
    expect(fromLoginctl(`IdleHint=yes\nIdleSinceHint=${since}\n`, now)).toBe(20 * 60_000);
    expect(fromLoginctl('IdleHint=no\nIdleSinceHint=0\n', now)).toBe(0);
    expect(fromLoginctl('', now)).toBeUndefined();
  });
});
