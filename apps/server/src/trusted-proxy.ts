import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Whose X-Forwarded-For the server takes. Places and seats reach the app directly on the
// compose network, so a count of proxies in front would take their header too: one of them
// could claim any address, around the sign-in rate limit and in the sessions' records. Given the
// proxy's addresses, networks or names, the server takes the header from those only.

/** How often a proxy named by its host name is looked up again: a restarted container moves. */
const LOOKUP_MS = 60_000;

/** Fastify's `trustProxy` for the setting, and a stop for its lookups. */
export function proxyTrust(setting: false | number | string[]): {
  trust: false | ((address: string, hop: number) => boolean);
  stop: () => void;
} {
  if (setting === false) return { trust: false, stop: () => {} };
  if (typeof setting === 'number') {
    return { trust: (_address, hop) => hop < setting, stop: () => {} };
  }
  const fixed = new BlockList();
  const names: string[] = [];
  for (const entry of setting) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address);
    if (family !== 0 && prefix !== undefined) {
      fixed.addSubnet(address, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
    } else if (family !== 0) {
      fixed.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
    } else {
      names.push(entry);
    }
  }
  let named = new Set<string>();
  const refresh = async () => {
    const found = new Set<string>();
    for (const name of names) {
      try {
        for (const { address } of await lookup(name, { all: true })) found.add(address);
      } catch {
        // Not up yet, as Caddy may not be when the app starts: the next lookup finds it.
      }
    }
    named = found;
  };
  void refresh();
  const timer = names.length > 0 ? setInterval(() => void refresh(), LOOKUP_MS) : undefined;
  timer?.unref();
  return {
    // Only the address that connected is checked: one proxy in front, whose last entry is the
    // client's. An IPv4 address seen as IPv6 (::ffff:) is the IPv4 one.
    trust: (address, hop) => {
      if (hop > 0) return false;
      const ip = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
      const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      return named.has(ip) || named.has(address) || (isIP(ip) !== 0 && fixed.check(ip, family));
    },
    stop: () => clearInterval(timer),
  };
}
