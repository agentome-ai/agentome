import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// How the server and the place launcher trust each other: every order is signed with a key both
// derive from the installation's secret, is good for a minute, and is taken once: it carries a
// number used once, so an order seen on the network cannot be sent again (a terminal opened
// twice, a place deleted after it was made again).

export const SIGNATURE_HEADER = 'x-agentome-signature';
export const TIME_HEADER = 'x-agentome-time';
export const NONCE_HEADER = 'x-agentome-nonce';
const GOOD_FOR_MS = 60_000;

/** A number for one order. */
export const newNonce = () => randomBytes(16).toString('hex');

/** The signature of one order: its method, path, time, number and body, nothing else. */
export function signOrder(
  key: string,
  method: string,
  path: string,
  time: string,
  nonce: string,
  body: string,
) {
  return createHmac('sha256', key)
    .update(`${method}\n${path}\n${time}\n${nonce}\n${body}`)
    .digest('hex');
}

export type Order = {
  method: string;
  path: string;
  time?: string;
  nonce?: string;
  signature?: string;
  body: string;
};

/** Whether an order is the server's, and fresh: signed, within its minute. */
export function orderIsSigned(key: string, order: Order, now = Date.now()): boolean {
  const { time, nonce, signature } = order;
  if (!time || !signature || !nonce || !/^\d{13}$/.test(time) || !/^[0-9a-f]{32}$/.test(nonce)) {
    return false;
  }
  if (Math.abs(now - Number(time)) > GOOD_FOR_MS) return false;
  const expected = Buffer.from(
    signOrder(key, order.method, order.path, time, nonce, order.body),
    'hex',
  );
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The numbers of the orders taken in the last two minutes: an order whose number is here was
 * taken already. Past its minute an order is refused anyway, so older numbers are let go.
 */
export function onceOnly(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (nonce: string): boolean => {
    const at = now();
    if (seen.size > 10_000) {
      for (const [old, when] of seen) if (at - when > 2 * GOOD_FOR_MS) seen.delete(old);
    }
    if (seen.has(nonce)) return false;
    seen.set(nonce, at);
    return true;
  };
}

/** The state of a person's place, as the launcher sees its container. */
export type PlaceState = 'none' | 'asleep' | 'awake';

/** A place is named by its person's id: one place each. */
export const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
