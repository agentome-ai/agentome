import { describe, expect, it } from 'vitest';
import { proxyTrust } from './trusted-proxy.js';

describe('whose X-Forwarded-For the server takes', () => {
  it("takes the named proxy's only, not a place's that reaches the app directly", async () => {
    const { trust, stop } = proxyTrust(['10.0.9.0/24', '192.168.40.7', 'localhost']);
    if (trust === false) throw new Error('trusted nobody');
    // localhost is looked up as the server starts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(trust('10.0.9.14', 0)).toBe(true);
    expect(trust('::ffff:10.0.9.14', 0)).toBe(true);
    expect(trust('192.168.40.7', 0)).toBe(true);
    expect(trust('127.0.0.1', 0)).toBe(true);
    // A place on the places' network, and the client behind the proxy: not trusted.
    expect(trust('172.28.0.5', 0)).toBe(false);
    expect(trust('10.0.9.14', 1)).toBe(false);
    stop();
  });

  it('keeps a count of proxies, or none, as before', () => {
    const counted = proxyTrust(1).trust;
    expect(counted !== false && counted('172.28.0.5', 0)).toBe(true);
    expect(proxyTrust(false).trust).toBe(false);
  });
});
