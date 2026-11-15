import { createHmac } from 'node:crypto';

/** A key for one purpose, so that no two features sign or encrypt with the same key. */
export function deriveKey(secretKey: string, purpose: string): string {
  return createHmac('sha256', secretKey).update(`agentome:${purpose}`).digest('hex');
}
