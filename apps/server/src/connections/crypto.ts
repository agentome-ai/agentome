import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '../auth.js';

// A connection's token and webhook secret at rest: AES-256-GCM under a key of its
// own purpose, so that no other feature can read them with its key. The record is
// `v1:<iv>:<tag>:<ciphertext>` in base64url; `v1` lets a later scheme read old rows.

const VERSION = 'v1';
const IV_BYTES = 12;

/** The 32-byte key of this purpose; `deriveKey` gives 32 bytes as hex. */
export function connectionsKey(secretKey: string): Buffer {
  return Buffer.from(deriveKey(secretKey, 'connections'), 'hex');
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url'));
  return [VERSION, ...parts].join(':');
}

/** Throws on a record of another version or key: a secret that cannot be read is a bug. */
export function decryptSecret(key: Buffer, record: string): string {
  const [version, iv, tag, body] = record.split(':');
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error('The encrypted secret is not in a form this server writes');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** A webhook secret the administrator pastes into the host: 32 random bytes, hex. */
export const newWebhookSecret = () => randomBytes(32).toString('hex');
