import { describe, expect, it, vi } from 'vitest';
import { isStale } from './fresh';

const page = (src: string) =>
  `<!doctype html><script>{}</script><script type="module" crossorigin src="${src}"></script>`;
const answer = (body: string, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));

describe('isStale', () => {
  it('tells a new version by the script index.html names', async () => {
    expect(await isStale('/assets/index-a.js', answer(page('/assets/index-b.js')))).toBe(true);
    expect(await isStale('/assets/index-a.js', answer(page('/assets/index-a.js')))).toBe(false);
  });

  it('keeps the page when the server cannot say', async () => {
    expect(await isStale('/assets/index-a.js', answer('', 502))).toBe(false);
    expect(await isStale('/assets/index-a.js', answer('<!doctype html>'))).toBe(false);
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await isStale('/assets/index-a.js', offline)).toBe(false);
  });
});
