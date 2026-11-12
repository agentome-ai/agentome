import { describe, expect, it } from 'vitest';
import { banner } from './banner.js';

describe('banner', () => {
  it('frames the line over the name, all rows one width, plain in a log', () => {
    const rows = banner('Agentome server is up at https://agents.example.com')
      .trimEnd()
      .split('\n');
    expect(rows).toHaveLength(9);
    expect(rows[1]).toBe(
      `│ ✻ Agentome server is up at https://agents.example.com${' '.repeat(16)}│`,
    );
    expect(new Set(rows.slice(0, 3).map((row) => row.length))).toEqual(new Set([72]));
    expect(rows.join('')).not.toContain('\x1b[');
  });

  it('cuts a long line to the frame, and colours only on a terminal', () => {
    const [, framed = ''] = banner('x'.repeat(200)).split('\n');
    expect(framed).toHaveLength(72);
    expect(banner('up', true)).toContain('\x1b[90m');
  });
});
