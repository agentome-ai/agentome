import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

// Seat and run tokens: 32 random bytes, base64url. The database keeps only the
// SHA-256, so a dump of it cannot act as a seat or a run. A plain fast hash is enough for
// random values with nothing to guess, and it keeps the lookup a single indexed read.

export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSecret(token) };
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The token of an `Authorization: Bearer` header, if it has the shape of one of ours. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '');
  return match?.[1];
}

// Read off a screen and typed into a terminal: no 0/O or 1/I to confuse.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** XXXX-XXXX: 40 random bits that live ten minutes and are spent once. */
export function newPairingCode(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${group().join('')}-${group().join('')}`;
}

/** `abcd efgh`, `ABCDEFGH` and `ABCD-EFGH` are the same code to a person and to the hash. */
export function normalizePairingCode(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}
