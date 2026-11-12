import { createHmac, timingSafeEqual } from 'node:crypto';

// How the server and the place launcher trust each other: every order is signed with a key both
// derive from the installation's secret, and is good for a minute.

export const SIGNATURE_HEADER = 'x-agentome-signature';
export const TIME_HEADER = 'x-agentome-time';
const GOOD_FOR_MS = 60_000;

/** The signature of one order: its method, path, time and body, nothing else. */
export function signOrder(key: string, method: string, path: string, time: string, body: string) {
  return createHmac('sha256', key).update(`${method}\n${path}\n${time}\n${body}`).digest('hex');
}

/** Whether an order is the server's, and fresh. */
export function orderIsSigned(
  key: string,
  order: { method: string; path: string; time?: string; signature?: string; body: string },
  now = Date.now(),
): boolean {
  const { time, signature } = order;
  if (!time || !signature || !/^\d{13}$/.test(time)) return false;
  if (Math.abs(now - Number(time)) > GOOD_FOR_MS) return false;
  const expected = Buffer.from(signOrder(key, order.method, order.path, time, order.body), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The state of a person's place, as the launcher sees its container. */
export type PlaceState = 'none' | 'asleep' | 'awake';

/** A place is named by its person's id: one place each. */
export const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
