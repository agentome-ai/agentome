import { createHmac, timingSafeEqual } from 'node:crypto';

// A file of its own, free of the workspace packages: `agentome setup-code` reads it, and the
// CLI runs without the agentome-dist condition that resolves them in the image.

/**
 * The code the first admin types at /setup, so that whoever reaches the port before the
 * operator cannot take the installation. It comes from the secret key: nothing to store, and
 * the operator finds it in the server's log or with `agentome setup-code`.
 */
export function setupCode(secretKey: string): string {
  const hex = createHmac('sha256', secretKey).update('agentome:setup-code').digest('hex');
  return (hex.slice(0, 16).match(/.{4}/g) ?? []).join('-');
}

/** Whether a typed code is the setup code: any case, with or without its dashes and spaces. */
export function isSetupCode(secretKey: string, typed: string): boolean {
  const plain = (code: string) => Buffer.from(code.replace(/[\s-]/g, '').toLowerCase());
  const want = plain(setupCode(secretKey));
  const got = plain(typed);
  return got.length === want.length && timingSafeEqual(got, want);
}
