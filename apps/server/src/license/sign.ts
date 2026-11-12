import { type KeyObject, sign } from 'node:crypto';

// Signing a license, apart from the rest of it: the `agentome` CLI imports this, and
// the CLI runs without the workspace packages' build, so nothing here may import them.

export const PREFIX = 'agentome-license-v1';

export type LicensePayload = {
  id: string;
  company: string;
  issuedAt: string;
  expiresAt: string;
  agents: number | null;
  /** The installation it is made out to; without one the key works anywhere. */
  installation?: string;
};

/** A license key for the payload, signed with the owner's private key: `agentome license sign`. */
export function signLicense(privateKey: KeyObject, payload: LicensePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(`${PREFIX}.${body}`), privateKey);
  return `${PREFIX}.${body}.${signature.toString('base64url')}`;
}
