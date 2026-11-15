import { describe, expect, it } from 'vitest';
import { checkedLookup, RemoteError } from './remote.js';

const look = (host: string, all: boolean) =>
  new Promise<{ error: Error | null; address: unknown }>((resolve) =>
    checkedLookup(host, { all }, (error, address) => resolve({ error, address })),
  );

describe("a library server's connection", () => {
  it('connects to no address of this machine, whatever the name answered to the check before', async () => {
    for (const all of [true, false]) {
      const refused = await look('localhost', all);
      expect(refused.error).toBeInstanceOf(RemoteError);
      expect(refused.error?.message).toMatch(/this machine or a link-local address/);
    }
  });

  it('connects to an address that is not', async () => {
    const found = await look('example.com', true);
    if (
      found.error &&
      /ENOTFOUND|EAI_AGAIN/.test(String((found.error as NodeJS.ErrnoException).code))
    ) {
      return; // No DNS where the tests run.
    }
    expect(found.error).toBeNull();
    expect(Array.isArray(found.address)).toBe(true);
  });
});
